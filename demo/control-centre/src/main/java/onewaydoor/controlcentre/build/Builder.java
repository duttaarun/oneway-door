package onewaydoor.controlcentre.build;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import onewaydoor.controlcentre.events.EventBus;
import onewaydoor.controlcentre.infra.Workspace;

/**
 * Builds a service from a git ref, for real: a detached git worktree at that commit, then the service's own Maven
 * wrapper. Jars are cached by the service folder's git tree hash, the same key the Docker scripts used for images.
 */
@Component
public class Builder {

    public record Built(String service, String ref, String commit, String tree, Path jar) {
        public String shortCommit() {
            return commit.substring(0, 7);
        }
    }

    private final Workspace workspace;
    private final Git git;
    private final EventBus events;
    private final String mavenOverride;

    public Builder(Workspace workspace, Git git, EventBus events, @Value("${owd.mvn:${OWD_MVN:}}") String mavenOverride) {
        this.workspace = workspace;
        this.git = git;
        this.events = events;
        this.mavenOverride = mavenOverride;
    }

    public boolean isBuilt(String service, String ref) {
        String commit = git.commit(ref);
        return Files.exists(jarPath(service, git.tree(commit, "demo/" + service)));
    }

    /** One build at a time: parallel Maven runs fight over ~/.m2 on a first run. */
    public synchronized Built build(String service, String ref) {
        String commit = git.commit(ref);
        String tree = git.tree(commit, "demo/" + service);
        Path jar = jarPath(service, tree);
        Built built = new Built(service, ref, commit, tree, jar);
        if (Files.exists(jar)) {
            return built;
        }
        Path wt = workspace.state("wt", service + "-" + commit.substring(0, 12));
        Path log = workspace.state("logs", "build-" + service + "-" + commit.substring(0, 12) + ".log");
        events.info("  building " + service + " from " + ref + " (" + commit.substring(0, 7) + ") in a git worktree…");
        events.publish("build", Map.of("service", service, "ref", ref, "status", "building"));
        long t0 = System.nanoTime();
        try {
            removeWorktree(wt);
            git.run("worktree", "add", "--quiet", "--detach", wt.toString(), commit);
            Path dir = wt.resolve("demo").resolve(service);
            ProcessBuilder pb = new ProcessBuilder(mavenCommand(dir, "package", "-DskipTests"))
                    .directory(dir.toFile()).redirectErrorStream(true).redirectOutput(log.toFile());
            pb.environment().put("JAVA_HOME", javaHome());
            Process p = pb.start();
            if (!p.waitFor(15, TimeUnit.MINUTES) || p.exitValue() != 0) {
                p.destroyForcibly();
                throw new IllegalStateException("Maven build failed for " + service + " at " + ref + ":\n" + tail(log, 25)
                        + "\n(full log: " + log + ")");
            }
            Files.createDirectories(jar.getParent());
            Files.copy(dir.resolve("target").resolve("app.jar"), jar, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            throw new IllegalStateException("Build failed for " + service + " at " + ref + ": " + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("interrupted", e);
        } finally {
            removeWorktree(wt);
        }
        long secs = (System.nanoTime() - t0) / 1_000_000_000;
        events.publish("build", Map.of("service", service, "ref", ref, "status", "built", "seconds", secs));
        events.info("  built " + service + " @ " + ref + " in " + secs + "s");
        return built;
    }

    /** The Maven command for a project folder: mvnw.cmd on Windows, mvnw elsewhere, or OWD_MVN if set. */
    public List<String> mavenCommand(Path dir, String... goals) {
        List<String> cmd = new ArrayList<>();
        if (!mavenOverride.isBlank()) {
            cmd.addAll(List.of(mavenOverride.split("\\s+")));
        } else if (Workspace.WINDOWS) {
            // Relative to the working directory: cmd.exe mangles a quoted first argument with spaces in it.
            cmd.addAll(List.of("cmd.exe", "/c", "mvnw.cmd"));
        } else {
            cmd.addAll(List.of("sh", dir.resolve("mvnw").toString()));
        }
        cmd.add("-B");
        cmd.add("-q");
        cmd.addAll(List.of(goals));
        return cmd;
    }

    /** JAVA_HOME for child builds: the JDK this JVM runs on, so Windows laptops need no JAVA_HOME of their own. */
    public static String javaHome() {
        Path exe = Path.of(Workspace.javaExecutable());
        Path home = exe.getParent() == null ? null : exe.getParent().getParent();
        return home == null ? System.getProperty("java.home") : home.toString();
    }

    private Path jarPath(String service, String tree) {
        return workspace.state("jars", service + "-" + tree.substring(0, 12) + ".jar");
    }

    private void removeWorktree(Path wt) {
        git.tryRun("worktree", "remove", "--force", wt.toString());
        git.tryRun("worktree", "prune");
        if (Files.exists(wt)) {
            try (var paths = Files.walk(wt)) {
                paths.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
            } catch (IOException ignored) {
                // Best effort; the next build uses `worktree add` on a fresh path anyway.
            }
        }
    }

    static String tail(Path file, int lines) {
        try {
            List<String> all = Files.readAllLines(file);
            return String.join("\n", all.subList(Math.max(0, all.size() - lines), all.size()));
        } catch (IOException e) {
            return "";
        }
    }
}
