package onewaydoor.controlcentre.api;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.stereotype.Component;

import onewaydoor.controlcentre.build.Git;
import onewaydoor.controlcentre.infra.EmbeddedInfra;
import onewaydoor.controlcentre.infra.Workspace;
import onewaydoor.controlcentre.scenario.Ops;
import onewaydoor.controlcentre.story.StoryService;

/** The laptop check: what the demo needs, and whether this machine has it. Shown in the UI's System panel. */
@Component
public class EnvCheck {

    private final Git git;
    private final EmbeddedInfra infra;
    private final Workspace workspace;

    public EnvCheck(Git git, EmbeddedInfra infra, Workspace workspace) {
        this.git = git;
        this.infra = infra;
        this.workspace = workspace;
    }

    public Map<String, Object> check() {
        Map<String, Object> c = new LinkedHashMap<>();
        int java = Runtime.version().feature();
        c.put("os", System.getProperty("os.name") + " " + System.getProperty("os.arch"));
        c.put("java", Map.of("version", System.getProperty("java.version"), "ok", java >= 21));
        String gitVersion = git.tryRun("--version").map(String::strip).orElse(null);
        c.put("git", Map.of("version", String.valueOf(gitVersion), "ok", gitVersion != null));
        List<String> missing = Ops.DEMO_REFS.stream().filter(r -> !git.exists(r)).toList();
        c.put("branches", Map.of("missing", missing, "ok", missing.isEmpty()));
        String node = StoryService.nodeVersion();
        c.put("node", Map.of("version", String.valueOf(node), "ok", node != null,
                "note", "Only for the Copilot skill's scripts (act 3). The demo itself runs without it."));
        c.put("infra", Map.of("status", infra.status().name(), "failure", String.valueOf(infra.failure()),
                "ok", infra.status() == EmbeddedInfra.Status.UP));
        c.put("mavenCentral", Map.of("ok", reachable("https://repo.maven.apache.org/maven2/"),
                "note", "Needed the first time each ref is built. Prepare builds them all."));
        c.put("root", workspace.root().toString());
        return c;
    }

    private static boolean reachable(String url) {
        try {
            HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3))
                    .followRedirects(HttpClient.Redirect.NORMAL).build();
            HttpResponse<Void> r = http.send(HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(4))
                    .method("HEAD", HttpRequest.BodyPublishers.noBody()).build(), HttpResponse.BodyHandlers.discarding());
            return r.statusCode() < 500;
        } catch (Exception e) {
            return false;
        }
    }
}
