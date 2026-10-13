package onewaydoor.controlcentre.runtime;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import jakarta.annotation.PreDestroy;
import onewaydoor.controlcentre.build.Builder;
import onewaydoor.controlcentre.build.Builder.Built;
import onewaydoor.controlcentre.events.EventBus;
import onewaydoor.controlcentre.infra.EmbeddedInfra;
import onewaydoor.controlcentre.infra.Workspace;

/**
 * Runs the Northwind services as plain java child processes: what the containers and `restart: on-failure` did.
 * A deploy builds the ref, stops the running version gracefully and starts the new one against today's database
 * and topic. A rollback is the same thing with an older ref.
 */
@Component
public class ServiceRunner {

    public static final String SETTLEMENT = "settlement-service";
    public static final String LEDGER = "ledger-service";
    public static final String RECON = "reconciliation-batch";
    public static final List<String> SERVICES = List.of(LEDGER, SETTLEMENT, RECON);

    public enum Status { STOPPED, STARTING, UP, FAILED }

    /** What runs (or last ran) for one service. */
    public static final class Deployed {
        final String service;
        final Built build;
        volatile Process process;
        volatile Status status = Status.STARTING;
        volatile String failure;
        volatile boolean failedToStart;
        final Deque<String> lines = new ArrayDeque<>();

        Deployed(String service, Built build) {
            this.service = service;
            this.build = build;
        }

        public Built build() {
            return build;
        }

        public Status status() {
            return status;
        }

        public String failure() {
            return failure;
        }

        public Long pid() {
            Process p = process;
            return p == null ? null : p.pid();
        }

        List<String> lines() {
            synchronized (lines) {
                return new ArrayList<>(lines);
            }
        }
    }

    private static final Logger log = LoggerFactory.getLogger(ServiceRunner.class);
    private static final Pattern ROOT_CAUSE = Pattern.compile("Caused by: |Schema-validation|FlywayValidateException|PSQLException");
    private static final Pattern NOTEWORTHY = Pattern.compile(
            "Booked |Already booked|Started \\w+Application|Migrating schema|Successfully applied|Schema .* is up to date"
                    + "|APPLICATION FAILED TO START|Schema-validation|ERROR|Sent |Published ");

    private final Builder builder;
    private final EmbeddedInfra infra;
    private final Workspace workspace;
    private final EventBus events;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(1)).build();
    private final Map<String, Deployed> deployed = new ConcurrentHashMap<>();

    public ServiceRunner(Builder builder, EmbeddedInfra infra, Workspace workspace, EventBus events) {
        this.builder = builder;
        this.infra = infra;
        this.workspace = workspace;
        this.events = events;
        killLeftovers();
    }

    public static int port(String service) {
        return switch (service) {
            case SETTLEMENT -> 8081;
            case LEDGER -> 8082;
            default -> 0;
        };
    }

    public Deployed deployed(String service) {
        return deployed.get(service);
    }

    public String deployedLabel(String service) {
        Deployed d = deployed.get(service);
        return d == null ? "not deployed" : d.build.ref() + " (" + d.build.shortCommit() + ")";
    }

    /**
     * Builds the service at the ref and (re)starts it on that build. Returns false if it doesn't come up healthy,
     * which is exactly what a rollback onto a one-way door looks like.
     */
    public boolean deploy(String service, String ref) {
        if (!SERVICES.contains(service)) {
            throw new IllegalArgumentException("Unknown service: " + service + " (expected one of " + SERVICES + ")");
        }
        Built build = builder.build(service, ref);
        if (RECON.equals(service)) {
            deployed.put(service, new Deployed(service, build));
            deployed.get(service).status = Status.UP;
            events.ok("reconciliation-batch @ " + ref + " (" + build.shortCommit() + ") ready (runs on demand)");
            return true;
        }
        stop(service);
        return start(service, build);
    }

    /** Starts the currently deployed build again, e.g. after a hotfix. */
    public boolean restart(String service) {
        Deployed d = deployed.get(service);
        if (d == null) {
            throw new IllegalStateException(service + " has never been deployed");
        }
        stop(service);
        return start(service, d.build);
    }

    private boolean start(String service, Built build) {
        infra.awaitUp();
        Deployed d = new Deployed(service, build);
        deployed.put(service, d);
        Path logFile = workspace.state("logs", service + ".log");
        List<String> cmd = new ArrayList<>(List.of(Workspace.javaExecutable(),
                "-XX:+UseSerialGC", "-Xss512k", "-XX:TieredStopAtLevel=1", "-Xmx256m",
                "-Dfile.encoding=UTF-8", "-jar", build.jar().toString(),
                // Launch-time only, no code change: lets us stop the service gracefully, so its Kafka consumer
                // leaves the group at once (Windows has no SIGTERM for a JVM).
                "--management.endpoints.web.exposure.include=health,info,shutdown",
                "--management.endpoint.shutdown.access=unrestricted",
                "--spring.output.ansi.enabled=never"));
        ProcessBuilder pb = new ProcessBuilder(cmd).redirectErrorStream(true);
        pb.environment().put("KAFKA_BOOTSTRAP", infra.kafkaBootstrap());
        pb.environment().put("DB_URL", infra.jdbcUrl());
        pb.environment().remove("JAVA_TOOL_OPTIONS");
        try {
            d.process = pb.start();
        } catch (IOException e) {
            d.status = Status.FAILED;
            d.failure = "could not start java: " + e.getMessage();
            events.fail(service + " @ " + build.ref() + ": " + d.failure);
            return false;
        }
        writePid(service, d.process.pid());
        Thread reader = new Thread(() -> pump(d, logFile), service + "-output");
        reader.setDaemon(true);
        reader.start();
        return waitHealthy(d, 150);
    }

    private void pump(Deployed d, Path logFile) {
        try (BufferedReader in = new BufferedReader(new InputStreamReader(d.process.getInputStream(), StandardCharsets.UTF_8));
             BufferedWriter out = Files.newBufferedWriter(logFile, StandardCharsets.UTF_8)) {
            String line;
            while ((line = in.readLine()) != null) {
                out.write(line);
                out.newLine();
                out.flush();
                synchronized (d.lines) {
                    d.lines.addLast(line);
                    while (d.lines.size() > 600) {
                        d.lines.removeFirst();
                    }
                }
                if (line.contains("APPLICATION FAILED TO START")) {
                    d.failedToStart = true;
                }
                if (NOTEWORTHY.matcher(line).find() && !line.startsWith("\t") && !line.startsWith(" ") && !line.startsWith("Caused by")) {
                    Map<String, Object> data = new LinkedHashMap<>();
                    data.put("service", d.service);
                    data.put("text", trimLogLine(line));
                    events.publish("svc", data);
                }
            }
        } catch (IOException e) {
            log.debug("{} output closed: {}", d.service, e.getMessage());
        }
    }

    /** Drops the Spring Boot log prefix (timestamp, level, pid, thread, logger) so the UI shows the message. */
    static String trimLogLine(String line) {
        int idx = line.indexOf(" : ");
        String msg = idx > 0 && idx < 220 ? line.substring(idx + 3) : line;
        return msg.length() > 240 ? msg.substring(0, 240) + "…" : msg;
    }

    private boolean waitHealthy(Deployed d, int timeoutSec) {
        String label = d.build.ref() + " (" + d.build.shortCommit() + ")";
        long deadline = System.currentTimeMillis() + timeoutSec * 1000L;
        while (System.currentTimeMillis() < deadline) {
            if ("UP".equals(health(d.service))) {
                d.status = Status.UP;
                events.ok(d.service + " @ " + label + " is UP (http://localhost:" + port(d.service) + "/actuator/health)");
                return true;
            }
            if (d.failedToStart || !d.process.isAlive()) {
                waitForExit(d.process, 5);
                d.status = Status.FAILED;
                d.failure = startupFailure(d.lines());
                events.fail(d.service + " @ " + label + " failed to start");
                events.log("fail", "    " + d.failure);
                return false;
            }
            sleep(500);
        }
        d.status = Status.FAILED;
        d.failure = "not healthy after " + timeoutSec + "s";
        events.fail(d.service + " @ " + label + " " + d.failure);
        return false;
    }

    /** The root cause of a failed Spring Boot start-up: same rule as startup_failure in demo/scripts/lib.sh. */
    public static String startupFailure(List<String> lines) {
        String found = null;
        for (String line : lines) {
            if (ROOT_CAUSE.matcher(line).find()) {
                found = line;
            }
        }
        if (found == null) {
            return "exited during start-up (no root cause in the log)";
        }
        String s = found.strip().replaceFirst("^Caused by: ", "");
        return s.length() > 220 ? s.substring(0, 220) : s;
    }

    public String health(String service) {
        int port = port(service);
        if (port == 0) {
            return "n/a";
        }
        try {
            HttpResponse<String> r = http.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/actuator/health"))
                    .timeout(Duration.ofSeconds(2)).GET().build(), HttpResponse.BodyHandlers.ofString());
            return r.body().contains("\"status\":\"UP\"") ? "UP" : "DOWN";
        } catch (IOException e) {
            return "unreachable";
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return "unreachable";
        }
    }

    /** Graceful stop through /actuator/shutdown, then a kill if it hasn't gone in 15 s. */
    public void stop(String service) {
        Deployed d = deployed.get(service);
        if (d == null || d.process == null || !d.process.isAlive()) {
            if (d != null) {
                d.status = d.status == Status.FAILED ? Status.FAILED : Status.STOPPED;
            }
            return;
        }
        try {
            http.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port(service) + "/actuator/shutdown"))
                    .timeout(Duration.ofSeconds(3)).POST(HttpRequest.BodyPublishers.noBody()).build(),
                    HttpResponse.BodyHandlers.discarding());
        } catch (IOException e) {
            // Not listening (yet): fall through to destroy.
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        if (!waitForExit(d.process, 15)) {
            d.process.destroy();
            if (!waitForExit(d.process, 5)) {
                d.process.destroyForcibly();
                waitForExit(d.process, 5);
            }
        }
        d.status = Status.STOPPED;
        deletePid(service);
    }

    @PreDestroy
    public void stopAll() {
        for (String service : List.of(SETTLEMENT, LEDGER)) {
            stop(service);
        }
    }

    /** Forgets everything: used by "down". */
    public void clear() {
        stopAll();
        deployed.clear();
    }

    /** Runs the deployed reconciliation-batch once and returns its output. */
    public String runReconciliation() {
        Deployed d = deployed.get(RECON);
        if (d == null) {
            return "RECON error=reconciliation-batch is not deployed";
        }
        ProcessBuilder pb = new ProcessBuilder(Workspace.javaExecutable(), "-Xmx128m", "-Dfile.encoding=UTF-8",
                "-Dstdout.encoding=UTF-8", "-jar", d.build.jar().toString()).redirectErrorStream(false);
        pb.environment().put("DB_URL", infra.jdbcUrl());
        pb.environment().remove("JAVA_TOOL_OPTIONS");
        try {
            Process p = pb.start();
            p.getErrorStream().transferTo(java.io.OutputStream.nullOutputStream());
            String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            if (!p.waitFor(60, TimeUnit.SECONDS)) {
                p.destroyForcibly();
                return out + "\nRECON error=timed out";
            }
            return out;
        } catch (IOException e) {
            return "RECON error=could not start java: " + e.getMessage();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return "RECON error=interrupted";
        }
    }

    // ---------- pid files: clean up services left running by a Control Centre that was killed ----------

    private void writePid(String service, long pid) {
        try {
            Files.writeString(workspace.state("run", service + ".pid"), Long.toString(pid));
        } catch (IOException e) {
            log.debug("pid file: {}", e.getMessage());
        }
    }

    private void deletePid(String service) {
        try {
            Files.deleteIfExists(workspace.state("run", service + ".pid"));
        } catch (IOException ignored) {
            // harmless
        }
    }

    private void killLeftovers() {
        for (String service : List.of(SETTLEMENT, LEDGER)) {
            Path pidFile = workspace.state("run", service + ".pid");
            try {
                if (!Files.exists(pidFile)) {
                    continue;
                }
                long pid = Long.parseLong(Files.readString(pidFile).strip());
                ProcessHandle.of(pid).filter(ProcessHandle::isAlive)
                        .filter(h -> h.info().commandLine().map(c -> c.contains(".demo")).orElse(true))
                        .ifPresent(h -> {
                            log.info("Stopping {} left over from an earlier run (pid {})", service, pid);
                            h.destroyForcibly();
                        });
                Files.deleteIfExists(pidFile);
            } catch (IOException | NumberFormatException e) {
                log.debug("leftover {}: {}", service, e.getMessage());
            }
        }
    }

    private static boolean waitForExit(Process p, int seconds) {
        try {
            return p.waitFor(seconds, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
