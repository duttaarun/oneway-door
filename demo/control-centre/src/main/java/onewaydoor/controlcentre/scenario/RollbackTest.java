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
        ops.down();
        if (!ops.up(from)) {
            reasons.add("baseline at " + from + " did not start");
            return finish(from, to, stages, reasons);
        }
        stages.add(stage(from, to, 0, at, reasons));

        move(ServiceRunner.LEDGER, to, STAGES.get(1), reasons);
        at[0] = to;
        stages.add(stage(from, to, 1, at, reasons));

        move(ServiceRunner.SETTLEMENT, to, STAGES.get(2), reasons);
        at[1] = to;
        stages.add(stage(from, to, 2, at, reasons));

        move(ServiceRunner.LEDGER, from, STAGES.get(3), reasons);
        at[0] = from;
        stages.add(stage(from, to, 3, at, reasons));

        move(ServiceRunner.SETTLEMENT, from, STAGES.get(4), reasons);
        at[1] = from;
        stages.add(stage(from, to, 4, at, reasons));

        return finish(from, to, stages, reasons);
    }

    private void move(String service, String ref, String stageName, Set<String> reasons) {
        if (!ops.runner.deploy(service, ref)) {
            reasons.add(stageName + ": " + service + " @ " + ref + " did not start: " + ops.runner.deployed(service).failure());
        }
        if (ServiceRunner.LEDGER.equals(service)) {
            try {
                ops.runner.deploy(ServiceRunner.RECON, ref);
            } catch (RuntimeException ex) {
                reasons.add(stageName + ": reconciliation-batch @ " + ref + " did not build");
            }
        }
    }

    private Map<String, Object> stage(String from, String to, int index, String[] at, Set<String> reasons) {
        String name = STAGES.get(index);
        List<String> mine = new ArrayList<>();
        try {
            if (ops.traffic.send(trafficPerStage).accepted() != trafficPerStage) {
                mine.add(name + ": settlement-service did not accept all traffic");
            }
        } catch (RuntimeException ex) {
            mine.add(name + ": settlement-service did not accept all traffic");
        }
        if ("UP".equals(ops.runner.health(ServiceRunner.LEDGER))) {
            ops.kafka.waitForDrain(60);
        } else {
            sleep(3000);
        }
        String lh = ops.runner.health(ServiceRunner.LEDGER);
        String sh = ops.runner.health(ServiceRunner.SETTLEMENT);
        long rows = safe(ops.ledger::rowCount);
        long zero = safe(ops.ledger::zeroCount);
        long dlt = ops.kafka.dlt();
        long lag = ops.kafka.lag();
        Recon recon = ops.recon();
        int expectedRows = ops.traffic.sentCount();
        BigDecimal expectedTotal = ops.traffic.sentTotal();

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
