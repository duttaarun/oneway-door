package onewaydoor.controlcentre.build;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

import org.springframework.stereotype.Component;

import onewaydoor.controlcentre.infra.Workspace;

/** Plain git, run as a process against the repository root. */
@Component
public class Git {

    private final Workspace workspace;

    public Git(Workspace workspace) {
        this.workspace = workspace;
    }

    public String run(String... args) {
        List<String> cmd = new ArrayList<>(List.of("git", "-c", "core.quotepath=off", "-C", workspace.root().toString()));
        cmd.addAll(List.of(args));
        try {
            Process p = new ProcessBuilder(cmd).redirectErrorStream(true).start();
            String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            if (!p.waitFor(60, TimeUnit.SECONDS) || p.exitValue() != 0) {
                throw new IllegalStateException("git " + String.join(" ", args) + " failed: " + out.strip());
            }
            return out;
        } catch (IOException e) {
            throw new IllegalStateException("git is not available: " + e.getMessage(), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("interrupted", e);
        }
    }

    public Optional<String> tryRun(String... args) {
        try {
            return Optional.of(run(args));
        } catch (IllegalStateException e) {
            return Optional.empty();
        }
    }

    public String commit(String ref) {
        return tryRun("rev-parse", "--verify", "--quiet", ref + "^{commit}").map(String::strip)
                .orElseThrow(() -> new IllegalArgumentException("Unknown git ref: " + ref));
    }

    public boolean exists(String ref) {
        return tryRun("rev-parse", "--verify", "--quiet", ref + "^{commit}").isPresent();
    }

    /** The git tree hash of a folder at a commit: two refs with identical service code share one build. */
    public String tree(String commit, String path) {
        return tryRun("rev-parse", "--verify", "--quiet", commit + ":" + path).map(String::strip)
                .orElseThrow(() -> new IllegalArgumentException(path + " does not exist at " + commit));
    }
}
