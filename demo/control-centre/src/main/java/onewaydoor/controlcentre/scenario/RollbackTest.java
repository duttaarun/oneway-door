package onewaydoor.controlcentre.scenario;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.springframework.stereotype.Component;

import onewaydoor.controlcentre.ledger.Ledger.Recon;
import onewaydoor.controlcentre.runtime.ServiceRunner;

/**
 * Proves whether {@code to} can be rolled back to {@code from}, for real. Port of rollback-test.sh:
 * <ol>
 * <li>Clean start at from, send traffic.</li>
 * <li>Deploy ledger-service (and reconciliation-batch) at to: new consumer, old producer.</li>
 * <li>Deploy settlement-service at to: both new.</li>
 * <li>Roll ledger-service back to from: old consumer, new producer.</li>
 * <li>Roll settlement-service back to from: both old.</li>
 * </ol>
 * After every stage: both services healthy, every settlement booked once, no £0.00 rows, an empty dead-letter topic,
 * no backlog, and a reconciliation total equal to what was sent.
 */
@Component
public class RollbackTest {

    public static final List<String> STAGES = List.of("1 baseline", "2 deploy ledger", "3 deploy settlement",
            "4 roll back ledger", "5 roll back settlement");

    private final Ops ops;
    private final int trafficPerStage;

    public RollbackTest(Ops ops) {
        this.ops = ops;
        this.trafficPerStage = Integer.parseInt(System.getenv().getOrDefault("TRAFFIC", "20"));
    }

    /** Returns {from, to, result, firstProblem, reasons, stages}. */
    public Map<String, Object> run(String from, String to) {
        ops.git.commit(from);
        ops.git.commit(to);
        var e = ops.events;
        Set<String> reasons = new LinkedHashSet<>();
        List<Map<String, Object>> stages = new ArrayList<>();
        String[] at = {from, from};       // ledger, settlement

        e.caption("Rollback test: " + from + " → " + to + " → back to " + from + "  (" + trafficPerStage + " settlements per stage)");
        e.info("  clean start at " + from + "…");
        publish(from, to, "running", null, stages, reasons);
        begin(from, to, 0, at, "Clean start: fresh database and topics, all three services at " + from);
        step(from, to, 0, "deploy", "Wiping the ledger and the topics, starting all three services at " + from + "…", "running");
        ops.down();
        if (!ops.up(from)) {
            step(from, to, 0, "deploy", "The baseline at " + from + " did not start", "fail");
            reasons.add("baseline at " + from + " did not start");
            return finish(from, to, stages, reasons);
        }
        step(from, to, 0, "deploy", "All three services at " + from + " are UP", "ok");
        stages.add(stage(from, to, 0, at, reasons));

        at[0] = to;
        move(from, to, 1, ServiceRunner.LEDGER, to, "Deploy ledger-service at " + to + ". settlement-service stays at " + from
                + ": a new reader, old events.", at, reasons);
        stages.add(stage(from, to, 1, at, reasons));

        at[1] = to;
        move(from, to, 2, ServiceRunner.SETTLEMENT, to, "Deploy settlement-service at " + to + ": both services new.", at, reasons);
        stages.add(stage(from, to, 2, at, reasons));

        at[0] = from;
        move(from, to, 3, ServiceRunner.LEDGER, from, "Roll ledger-service back to " + from + ". The database keeps " + to
                + "'s migration: an old reader, new data.", at, reasons);
        stages.add(stage(from, to, 3, at, reasons));

        at[1] = from;
        move(from, to, 4, ServiceRunner.SETTLEMENT, from, "Roll settlement-service back to " + from
                + ". Both old, on the new database.", at, reasons);
        stages.add(stage(from, to, 4, at, reasons));

        return finish(from, to, stages, reasons);
    }

    private void move(String from, String to, int index, String service, String ref, String action, String[] at,
            Set<String> reasons) {
        String stageName = STAGES.get(index);
        begin(from, to, index, at, action);
        step(from, to, index, "deploy", "Building " + service + " at " + ref + " from git and starting it…", "running");
        if (ops.runner.deploy(service, ref)) {
            step(from, to, index, "deploy", service + " at " + ref + " is UP", "ok");
        } else {
            String why = ops.runner.deployed(service).failure();
            step(from, to, index, "deploy", service + " at " + ref + " did not start: " + why, "fail");
            reasons.add(stageName + ": " + service + " @ " + ref + " did not start: " + why);
        }
        if (ServiceRunner.LEDGER.equals(service)) {
            try {
                ops.runner.deploy(ServiceRunner.RECON, ref);
            } catch (RuntimeException ex) {
                reasons.add(stageName + ": reconciliation-batch @ " + ref + " did not build");
            }
        }
    }

    /** A stage begins: which versions run, and what the stage does. The UI shows it live. */
    private void begin(String from, String to, int index, String[] at, String action) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("from", from);
        m.put("to", to);
        m.put("index", index);
        m.put("stage", STAGES.get(index));
        m.put("ledgerRef", at[0]);
        m.put("settlementRef", at[1]);
        m.put("action", action);
        ops.events.publish("rtStage", m);
    }

    /** One step inside a stage (deploy, traffic, drain, reconciliation), with status running, ok or fail. */
    private void step(String from, String to, int index, String id, String text, String status) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("from", from);
        m.put("to", to);
        m.put("index", index);
        m.put("id", id);
        m.put("text", text);
        m.put("status", status);
        ops.events.publish("rtStep", m);
    }

    private Map<String, Object> stage(String from, String to, int index, String[] at, Set<String> reasons) {
        String name = STAGES.get(index);
        List<String> mine = new ArrayList<>();
        step(from, to, index, "traffic", "Sending " + trafficPerStage + " settlements to settlement-service…", "running");
        try {
            var sent = ops.traffic.send(trafficPerStage);
            if (sent.accepted() != trafficPerStage) {
                mine.add(name + ": settlement-service did not accept all traffic");
                step(from, to, index, "traffic", "Only " + sent.accepted() + " of " + trafficPerStage + " settlements accepted", "fail");
            } else {
                step(from, to, index, "traffic", trafficPerStage + " settlements sent to Kafka (£" + sent.total().toPlainString() + ")", "ok");
            }
        } catch (RuntimeException ex) {
            mine.add(name + ": settlement-service did not accept all traffic");
            step(from, to, index, "traffic", "settlement-service did not accept the settlements", "fail");
        }
        if ("UP".equals(ops.runner.health(ServiceRunner.LEDGER))) {
            step(from, to, index, "drain", "Waiting for ledger-service to book them…", "running");
            boolean drained = ops.kafka.waitForDrain(60);
            step(from, to, index, "drain", drained ? "ledger-service consumed every event" : ops.kafka.lag() + " events still waiting on Kafka",
                    drained ? "ok" : "fail");
        } else {
            step(from, to, index, "drain", "ledger-service is down: the events wait on Kafka", "fail");
            sleep(3000);
        }
        step(from, to, index, "recon", "Running reconciliation-batch…", "running");
        String lh = ops.runner.health(ServiceRunner.LEDGER);
        String sh = ops.runner.health(ServiceRunner.SETTLEMENT);
        long rows = safe(ops.ledger::rowCount);
        long zero = safe(ops.ledger::zeroCount);
        long dlt = ops.kafka.dlt();
        long lag = ops.kafka.lag();
        Recon recon = ops.recon();
        int expectedRows = ops.traffic.sentCount();
        BigDecimal expectedTotal = ops.traffic.sentTotal();
        step(from, to, index, "recon", recon.total() == null ? "Reconciliation failed: " + recon.error()
                : "Reconciliation total £" + recon.total().toPlainString(), recon.total() == null ? "fail" : "ok");

        if (!"UP".equals(lh)) {
            mine.add(name + ": ledger-service is " + lh);
        }
        if (!"UP".equals(sh)) {
            mine.add(name + ": settlement-service is " + sh);
        }
        if (zero != 0) {
            mine.add(name + ": " + zero + " rows booked at £0.00");
        }
        if (dlt != 0) {
            mine.add(name + ": " + dlt + " records in the dead-letter topic");
        }
        if (lag != 0) {
            mine.add(name + ": " + lag + " settlements not booked (backlog)");
        }
        if (rows != expectedRows) {
            mine.add(name + ": " + rows + " rows booked, " + expectedRows + " sent");
        }
        String reconCell;
        if (recon.total() == null) {
            mine.add(name + ": reconciliation failed: " + recon.error());
            reconCell = "error";
        } else if (recon.total().compareTo(expectedTotal) != 0) {
            mine.add(name + ": reconciliation £" + recon.total().toPlainString() + ", sent £" + expectedTotal.toPlainString());
            reconCell = "£" + recon.total().toPlainString() + " ≠ £" + expectedTotal.toPlainString();
        } else {
            reconCell = "£" + recon.total().toPlainString();
        }
        if (recon.mismatches() != null && recon.mismatches() != 0) {
            mine.add(name + ": amount and amount_minor disagree on " + recon.mismatches() + " rows");
        }
        reasons.addAll(mine);

        Map<String, Object> row = new LinkedHashMap<>();
        row.put("test", from + " → " + to);
        row.put("from", from);
        row.put("to", to);
        row.put("index", index);
        row.put("stage", name);
        row.put("ledgerRef", at[0]);
        row.put("settlementRef", at[1]);
        row.put("rows", rows);
        row.put("expectedRows", expectedRows);
        row.put("zero", zero);
        row.put("dlt", dlt);
        row.put("lag", lag);
        row.put("recon", reconCell);
        row.put("reconTotal", recon.total());
        row.put("reconError", recon.error());
        row.put("mismatches", recon.mismatches());
        row.put("expectedTotal", expectedTotal);
        row.put("ledgerHealth", lh);
        row.put("settlementHealth", sh);
        row.put("ok", mine.isEmpty());
        row.put("problems", mine);
        ops.events.publish("stage", row);
        ops.events.log(mine.isEmpty() ? "ok" : "fail", String.format("  %-24s ledger %-18s settlement %-18s rows %d/%d  £0.00 %d  DLT %d  lag %d  %s  %s",
                name, at[0], at[1], rows, expectedRows, zero, dlt, lag, reconCell, mine.isEmpty() ? "ok" : "FAIL"));
        return row;
    }

    private Map<String, Object> finish(String from, String to, List<Map<String, Object>> stages, Set<String> reasons) {
        boolean pass = reasons.isEmpty();
        if (pass) {
            ops.events.ok("PASS  " + from + " → " + to + " deploys and rolls back with no errors, no £0.00 rows, an empty DLT and correct totals.");
        } else {
            ops.events.fail("FAIL  " + from + " → " + to + " cannot be rolled back safely:");
            reasons.stream().limit(12).forEach(r -> ops.events.log("fail", "    - " + r));
        }
        Map<String, Object> out = publish(from, to, pass ? "PASS" : "FAIL", reasons.isEmpty() ? null : reasons.iterator().next(), stages, reasons);
        return out;
    }

    private Map<String, Object> publish(String from, String to, String result, String firstProblem,
            List<Map<String, Object>> stages, Set<String> reasons) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("from", from);
        out.put("to", to);
        out.put("result", result);
        out.put("firstProblem", firstProblem);
        out.put("reasons", new ArrayList<>(reasons));
        out.put("stages", new ArrayList<>(stages));
        ops.events.publish("rollbackTest", out);
        return out;
    }

    private static long safe(java.util.function.LongSupplier s) {
        try {
            return s.getAsLong();
        } catch (RuntimeException e) {
            return -1;
        }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
