package onewaydoor.controlcentre;

import java.awt.Desktop;
import java.net.URI;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.stereotype.Component;

import onewaydoor.controlcentre.events.EventBus;
import onewaydoor.controlcentre.infra.EmbeddedInfra;
import onewaydoor.controlcentre.infra.Workspace;
import onewaydoor.controlcentre.scenario.Incident;
import onewaydoor.controlcentre.scenario.Matrix;
import onewaydoor.controlcentre.scenario.Ops;
import onewaydoor.controlcentre.scenario.RollbackTest;
import onewaydoor.controlcentre.scenario.ScenarioRunner;

/**
 * With --owd.run=incident|matrix|prepare|rollback-test the Control Centre runs that scenario without a browser,
 * prints what the old scripts printed, and exits 0 (as expected) or 1. Otherwise it opens the UI.
 */
@Component
public class HeadlessRunner implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(HeadlessRunner.class);

    private final String run;
    private final boolean record;
    private final boolean openBrowser;
    private final int port;
    private final ConfigurableApplicationContext context;
    private final EventBus events;
    private final EmbeddedInfra infra;
    private final ScenarioRunner scenarios;
    private final Incident incident;
    private final Matrix matrix;
    private final RollbackTest rollbackTest;
    private final Ops ops;
    private final Workspace workspace;

    public HeadlessRunner(@Value("${owd.run:}") String run, @Value("${owd.record:false}") boolean record,
            @Value("${owd.open-browser:true}") boolean openBrowser, @Value("${server.port}") int port,
            ConfigurableApplicationContext context, EventBus events, EmbeddedInfra infra, ScenarioRunner scenarios,
            Incident incident, Matrix matrix, RollbackTest rollbackTest, Ops ops, Workspace workspace) {
        this.run = run;
        this.record = record;
        this.openBrowser = openBrowser;
        this.port = port;
        this.context = context;
        this.events = events;
        this.infra = infra;
        this.scenarios = scenarios;
        this.incident = incident;
        this.matrix = matrix;
        this.rollbackTest = rollbackTest;
        this.ops = ops;
        this.workspace = workspace;
    }

    @Override
    public void run(ApplicationArguments args) throws Exception {
        if (run.isBlank()) {
            String url = "http://localhost:" + port;
            log.info("One-Way Door Control Centre: {}", url);
            if (openBrowser) {
                open(url);
            }
            return;
        }
        events.echoToConsole(true);
        int code;
        try {
            infra.awaitUp();
            code = scenarios.runAndWait(() -> switch (run) {
                case "incident" -> {
                    if (record) {
                        events.startRecording();
                    }
                    boolean ok = incident.runAll();
                    if (record) {
                        Thread.sleep(1500);
                        events.stopRecording(workspace.root().resolve("demo/control-centre/recordings/incident.json"),
                                Map.of("name", "incident", "reproduced", ok));
                    }
                    yield ok ? 0 : 1;
                }
                case "matrix" -> matrix.run() ? 0 : 1;
                case "prepare", "reset" -> {
                    ops.prepare();
                    yield 0;
                }
                case "rollback-test" -> {
                    String from = context.getEnvironment().getProperty("owd.from", "main");
                    String to = context.getEnvironment().getProperty("owd.to", "split/1-expand");
                    yield "PASS".equals(rollbackTest.run(from, to).get("result")) ? 0 : 1;
                }
                default -> throw new IllegalArgumentException("Unknown --owd.run=" + run
                        + " (expected incident, matrix, prepare or rollback-test)");
            });
        } catch (Exception e) {
            log.error("{} failed: {}", run, e.getMessage(), e);
            code = 2;
        }
        int exit = code;
        System.exit(SpringApplication.exit(context, () -> exit));
    }

    /** Opens the default browser without java.awt (Spring Boot runs headless). */
    private static void open(String url) {
        String os = System.getProperty("os.name", "").toLowerCase();
        try {
            if (os.startsWith("windows")) {
                new ProcessBuilder("rundll32", "url.dll,FileProtocolHandler", url).start();
            } else if (os.contains("mac")) {
                new ProcessBuilder("open", url).start();
            } else if (Desktop.isDesktopSupported()) {
                Desktop.getDesktop().browse(URI.create(url));
            } else {
                new ProcessBuilder("xdg-open", url).start();
            }
        } catch (Exception e) {
            log.info("Open {} in your browser", url);
        }
    }
}
