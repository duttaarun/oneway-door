package onewaydoor.controlcentre.infra;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Where things live: the repository root (found by walking up) and the runtime state under .demo/cc. */
@Component
public class Workspace {

    public static final boolean WINDOWS = System.getProperty("os.name", "").toLowerCase().startsWith("windows");

    private final Path root;
    private final Path state;

    public Workspace(@Value("${owd.root:}") String configuredRoot) {
        this.root = configuredRoot.isBlank() ? findRoot(Path.of("").toAbsolutePath()) : Path.of(configuredRoot).toAbsolutePath();
        this.state = root.resolve(".demo").resolve("cc");
        for (String dir : new String[] {"jars", "logs", "wt", "run", "results"}) {
            try {
                Files.createDirectories(state.resolve(dir));
            } catch (IOException e) {
                throw new UncheckedIOException(e);
            }
        }
    }

    public static Path findRoot(Path from) {
        for (Path p = from; p != null; p = p.getParent()) {
            if (Files.exists(p.resolve(".git")) && Files.isDirectory(p.resolve("demo").resolve("ledger-service"))) {
                return p;
            }
        }
        throw new IllegalStateException("Run the Control Centre from inside the one-way-door repository (no .git with "
                + "demo/ledger-service found above " + from + "), or pass --owd.root=<path>");
    }

    public Path root() {
        return root;
    }

    public Path state() {
        return state;
    }

    public Path state(String first, String... more) {
        return state.resolve(Path.of(first, more));
    }

    /** The java executable this JVM runs on, so every child process uses the same Java. */
    public static String javaExecutable() {
        return ProcessHandle.current().info().command().orElse(WINDOWS ? "java.exe" : "java");
    }
}
