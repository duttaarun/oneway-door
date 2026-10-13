package onewaydoor.controlcentre.scenario;

import java.io.IOException;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;

import org.springframework.stereotype.Component;

import onewaydoor.controlcentre.build.Builder;
import onewaydoor.controlcentre.build.Git;
import onewaydoor.controlcentre.events.EventBus;
import onewaydoor.controlcentre.events.TopicObserver;
import onewaydoor.controlcentre.infra.EmbeddedInfra;
import onewaydoor.controlcentre.infra.Workspace;
import onewaydoor.controlcentre.ledger.KafkaStats;
import onewaydoor.controlcentre.ledger.Ledger;
import onewaydoor.controlcentre.ledger.Ledger.Recon;
import onewaydoor.controlcentre.ledger.Traffic;
import onewaydoor.controlcentre.runtime.ServiceRunner;

/** The building blocks the old scripts provided: up, down, deploy, rollback, hotfix, reconciliation, ledger. */
@Component
public class Ops {

    public static final List<String> DEMO_REFS = List.of("main", "pr-482-minor-units", "split/1-expand",
            "split/2-migrate", "split/3-contract", "split/4-drop");

    final EmbeddedInfra infra;
    final ServiceRunner runner;
    final Builder builder;
    final Git git;
    final Ledger ledger;
    final KafkaStats kafka;
    final Traffic traffic;
    final TopicObserver observer;
    final EventBus events;
    final Workspace workspace;

    public Ops(EmbeddedInfra infra, ServiceRunner runner, Builder builder, Git git, Ledger ledger, KafkaStats kafka,
            Traffic traffic, TopicObserver observer, EventBus events, Workspace workspace) {
        this.infra = infra;
        this.runner = runner;
        this.builder = builder;
        this.git = git;
        this.ledger = ledger;
        this.kafka = kafka;
        this.traffic = traffic;
        this.observer = observer;
        this.events = events;
        this.workspace = workspace;
    }

    /** Stops every service and wipes the ledger database and the topics: `docker compose down -v`. */
    public void down() {
        runner.clear();
        try {
            infra.reset();
        } catch (Exception e) {
            throw new IllegalStateException("Could not reset Postgres/Kafka: " + e.getMessage(), e);
        }
        traffic.reset();
        observer.reset();
        lastRecon = null;
        events.info("stopped all services; ledger database and topics are fresh");
    }

    /** Starts all three services at a ref. */
    public boolean up(String ref) {
        events.caption("Starting Northwind Payments at " + ref);
        infra.awaitUp();
        events.ok("postgres and kafka are up; topics payments.settled and payments.settled.DLT exist");
        for (String service : ServiceRunner.SERVICES) {
            if (!runner.deploy(service, ref)) {
                return false;
            }
        }
        return true;
    }

    public boolean deploy(String service, String ref) {
        events.caption("Deploying " + service + " → " + ref + "  (was: " + runner.deployedLabel(service) + ")");
        return runner.deploy(service, ref);
    }

    public boolean rollback(String service, String ref) {
        events.caption("Rolling back " + service + " → " + ref + "  (was: " + runner.deployedLabel(service) + ")");
        return runner.deploy(service, ref);
    }

    /** Applies demo/scripts/hotfix-reverse-v42.sql and restarts ledger-service on the same build. */
    public boolean hotfix() {
        events.caption("Applying hotfix-reverse-v42.sql");
        if (!ledger.hasColumn("amount_minor")) {
            throw new IllegalStateException("ledger_entries has no amount_minor column; V42 isn't applied, nothing to reverse");
        }
        Path file = workspace.root().resolve("demo/scripts/hotfix-reverse-v42.sql");
        try {
            ledger.runScript(Files.readString(file));
        } catch (IOException e) {
            throw new IllegalStateException("Cannot read " + file + ": " + e.getMessage(), e);
        }
        events.ok("ledger_entries.amount_minor (pence, bigint) is back to amount (pounds, numeric(12,2))");
        return runner.restart(ServiceRunner.LEDGER);
    }

    private volatile java.util.Map<String, Object> lastRecon;

    public java.util.Map<String, Object> lastRecon() {
        return lastRecon;
    }

    public Recon recon() {
        Recon r = Ledger.parseRecon(runner.runReconciliation());
        java.util.Map<String, Object> m = new java.util.LinkedHashMap<>();
        m.put("ref", runner.deployedLabel(ServiceRunner.RECON));
        m.put("entries", r.entries());
        m.put("total", r.total());
        m.put("mismatches", r.mismatches());
        m.put("error", r.error());
        m.put("at", java.time.Instant.now().toString());
        lastRecon = m;
        events.publish("recon", m);
        if (r.error() != null) {
            events.fail("reconciliation-batch: " + r.error());
        } else {
            events.info("  Reconciliation: " + r.entries() + " ledger entries, total £" + r.total().toPlainString()
                    + (r.mismatches() == null ? "" : ", mismatches " + r.mismatches()));
        }
        return r;
    }

    /** What ledger.sh printed: the summary lines (the UI shows the rows itself). */
    public void ledgerReport() {
        Ledger.Summary s = ledger.summary(5);
        if (s.columns().isEmpty()) {
            events.warn("ledger_entries has no amount column yet (ledger-service never started?)");
            return;
        }
        events.info(String.format(Locale.ROOT, "  ledger_entries (%s): %d rows, £%s booked, %d at £0.00 · sent %d (£%s) · backlog %d · DLT %d",
                String.join(", ", s.columns()), s.rows(), s.booked().toPlainString(), s.zero(), traffic.sentCount(),
                traffic.sentTotal().toPlainString(), kafka.lag(), kafka.dlt()));
    }

    /** Before the talk: build every ref (so nothing compiles on stage), then v1 with 10 settlements. */
    public void prepare() {
        long t0 = System.nanoTime();
        events.caption("Preparing the demo");
        for (String ref : DEMO_REFS) {
            if (!git.exists(ref)) {
                events.warn("missing branch " + ref);
                continue;
            }
            for (String service : ServiceRunner.SERVICES) {
                builder.build(service, ref);
            }
        }
        events.ok("builds ready for: " + String.join(" ", DEMO_REFS));
        down();
        if (!up("main")) {
            throw new IllegalStateException("v1 did not start");
        }
        traffic.send(10);
        if (!kafka.waitForDrain(30)) {
            events.warn("baseline not fully booked yet");
        }
        events.ok("ready in " + (System.nanoTime() - t0) / 1_000_000_000 + "s. Start with act 1.");
    }

    static String money(BigDecimal v) {
        return v == null ? "?" : "£" + v.setScale(2).toPlainString();
    }
}
