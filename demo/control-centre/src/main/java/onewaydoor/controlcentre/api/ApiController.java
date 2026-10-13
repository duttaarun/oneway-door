package onewaydoor.controlcentre.api;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import onewaydoor.controlcentre.build.Git;
import onewaydoor.controlcentre.events.EventBus;
import onewaydoor.controlcentre.infra.Workspace;
import onewaydoor.controlcentre.ledger.Traffic;
import onewaydoor.controlcentre.runtime.ServiceRunner;
import onewaydoor.controlcentre.scenario.Incident;
import onewaydoor.controlcentre.scenario.Matrix;
import onewaydoor.controlcentre.scenario.Ops;
import onewaydoor.controlcentre.scenario.RollbackTest;
import onewaydoor.controlcentre.scenario.ScenarioRunner;
import onewaydoor.controlcentre.story.StoryService;

/**
 * The UI's API. Reads return at once; every action is queued on the scenario thread and reports progress through
 * the event stream (/api/events), so the browser never waits on a deploy.
 */
@RestController
@RequestMapping("/api")
public class ApiController {

    public record DeployRequest(String service, String ref) {
    }

    public record TrafficRequest(Integer count) {
    }

    public record RefRequest(String ref) {
    }

    public record RollbackTestRequest(String from, String to) {
    }

    private final EventBus events;
    private final StateService state;
    private final ScenarioRunner scenarios;
    private final Ops ops;
    private final Incident incident;
    private final RollbackTest rollbackTest;
    private final Matrix matrix;
    private final StoryService story;
    private final Traffic traffic;
    private final Git git;
    private final Workspace workspace;
    private final EnvCheck env;

    public ApiController(EventBus events, StateService state, ScenarioRunner scenarios, Ops ops, Incident incident,
            RollbackTest rollbackTest, Matrix matrix, StoryService story, Traffic traffic, Git git, Workspace workspace,
            EnvCheck env) {
        this.events = events;
        this.state = state;
        this.scenarios = scenarios;
        this.ops = ops;
        this.incident = incident;
        this.rollbackTest = rollbackTest;
        this.matrix = matrix;
        this.story = story;
        this.traffic = traffic;
        this.git = git;
        this.workspace = workspace;
        this.env = env;
    }

    // ---------- reads ----------

    @GetMapping(path = "/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events() {
        return events.subscribe();
    }

    @GetMapping("/state")
    public Map<String, Object> state() {
        return state.snapshot();
    }

    @GetMapping("/env")
    public Map<String, Object> env() {
        return env.check();
    }

    @GetMapping("/refs")
    public Map<String, Object> refs() {
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("refs", Ops.DEMO_REFS.stream().filter(git::exists).toList());
        r.put("services", ServiceRunner.SERVICES);
        r.put("incidentSteps", Incident.STEPS);
        r.put("stages", RollbackTest.STAGES);
        r.put("cases", Matrix.CASES.stream().map(c -> Map.of("from", c[0], "to", c[1], "expected", Matrix.expected(c[1]))).toList());
        return r;
    }

    @GetMapping("/story/act1")
    public Map<String, Object> act1() {
        return story.act1();
    }

    @GetMapping("/story/act3")
    public Map<String, Object> act3() {
        return story.act3();
    }

    @GetMapping("/story/act4")
    public Map<String, Object> act4() {
        return story.act4();
    }

    /** The last matrix run: this machine's if it has one, otherwise the committed one. */
    @GetMapping(path = "/matrix", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<String> matrixResults() throws IOException {
        Path committed = workspace.root().resolve("demo/control-centre/recordings/matrix.json");
        if (!Files.exists(committed)) {
            return ResponseEntity.ok("{\"results\":[]}");
        }
        return ResponseEntity.ok(Files.readString(committed));
    }

    @GetMapping(path = "/recordings/{name}", produces = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<String> recording(@PathVariable String name) throws IOException {
        if (!name.matches("[a-z0-9-]+")) {
            return ResponseEntity.badRequest().build();
        }
        Path file = workspace.root().resolve("demo/control-centre/recordings/" + name + ".json");
        return Files.exists(file) ? ResponseEntity.ok(Files.readString(file)) : ResponseEntity.notFound().build();
    }

    // ---------- actions ----------

    @PostMapping("/prepare")
    public ResponseEntity<Map<String, Object>> prepare() {
        return submit("Prepare", () -> {
            events.clearLogs();
            incident.restart();
            ops.prepare();
        });
    }

    @PostMapping("/incident/next")
    public ResponseEntity<Map<String, Object>> incidentNext() {
        return submit("Incident step " + (incident.next() % Incident.STEPS.size() + 1), incident::runNext);
    }

    @PostMapping("/incident/autoplay")
    public ResponseEntity<Map<String, Object>> incidentAutoplay() {
        return submit("Incident (autoplay)", incident::runAll);
    }

    @PostMapping("/incident/restart")
    public ResponseEntity<Map<String, Object>> incidentRestart() {
        return submit("Restart incident", incident::restart);
    }

    /** Records a full live incident to recordings/incident.json (what replay mode plays). */
    @PostMapping("/incident/record")
    public ResponseEntity<Map<String, Object>> incidentRecord() {
        return submit("Recording the incident", () -> {
            incident.restart();
            events.clearLogs();
            events.startRecording();
            boolean ok = incident.runAll();
            Thread.sleep(1500);   // one more state snapshot after the end
            events.stopRecording(workspace.root().resolve("demo/control-centre/recordings/incident.json"),
                    Map.of("name", "incident", "reproduced", ok));
            events.ok("recorded to demo/control-centre/recordings/incident.json");
        });
    }

    @PostMapping("/rollback-test")
    public ResponseEntity<Map<String, Object>> rollbackTest(@RequestBody RollbackTestRequest req) {
        return submit("Rollback test " + req.from() + " → " + req.to(), () -> rollbackTest.run(req.from(), req.to()));
    }

    @PostMapping("/matrix")
    public ResponseEntity<Map<String, Object>> runMatrix() {
        return submit("Rollback matrix", matrix::run);
    }

    @PostMapping("/deploy")
    public ResponseEntity<Map<String, Object>> deploy(@RequestBody DeployRequest req) {
        return submit("Deploy " + req.service() + " → " + req.ref(), () -> ops.deploy(req.service(), req.ref()));
    }

    @PostMapping("/traffic")
    public ResponseEntity<Map<String, Object>> traffic(@RequestBody TrafficRequest req) {
        int n = req.count() == null ? 20 : Math.max(1, Math.min(500, req.count()));
        return submit("Send " + n + " settlements", () -> traffic.send(n));
    }

    @PostMapping("/hotfix")
    public ResponseEntity<Map<String, Object>> hotfix() {
        return submit("Hotfix", ops::hotfix);
    }

    @PostMapping("/recon")
    public ResponseEntity<Map<String, Object>> recon() {
        return submit("Reconciliation", ops::recon);
    }

    @PostMapping("/up")
    public ResponseEntity<Map<String, Object>> up(@RequestBody RefRequest req) {
        String ref = req.ref() == null ? "main" : req.ref();
        return submit("Start at " + ref, () -> {
            ops.down();
            ops.up(ref);
        });
    }

    @PostMapping("/down")
    public ResponseEntity<Map<String, Object>> down() {
        return submit("Stop everything", ops::down);
    }

    @PostMapping("/tests")
    public ResponseEntity<Map<String, Object>> tests(@RequestBody RefRequest req) {
        String ref = req.ref() == null ? StoryService.BAD : req.ref();
        return submit("Unit tests at " + ref, () -> story.runTests(ref));
    }

    private ResponseEntity<Map<String, Object>> submit(String name, ScenarioRunner.Job job) {
        if (scenarios.submit(name, job)) {
            return ResponseEntity.accepted().body(Map.of("started", name));
        }
        return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("busy", String.valueOf(scenarios.busy())));
    }
}
