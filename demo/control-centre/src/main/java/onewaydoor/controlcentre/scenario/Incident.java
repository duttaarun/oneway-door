package onewaydoor.controlcentre.scenario;

import java.math.BigDecimal;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.stereotype.Component;

import onewaydoor.controlcentre.ledger.Ledger.Recon;
import onewaydoor.controlcentre.runtime.ServiceRunner;

/**
 * "The £0.00 Settlement", reproduced for real, one step at a time: real builds from git, a real rollback, a real
 * hand-written hotfix, and real events that v1 books at £0.00 without a single error. Port of incident.sh.
 */
@Component
public class Incident {

    public static final String BAD = "pr-482-minor-units";

    /** One step of the story: what the narrator card shows, and what runs. */
    public record Step(String id, String time, String title, String caption, String say) {
    }

    public static final List<Step> STEPS = List.of(
            new Step("v1", "16:30", "v1 in pounds",
                    "Friday 16:30. Northwind Payments runs v1 (main). Settlements are booked in pounds.",
                    "Friday afternoon. Ten settlements, all in pounds."),
            new Step("deploy", "16:40", "PR #482 ships",
                    "16:40. PR #482 'store amounts in minor units' is merged. Tests are green. Ship it.",
                    "PR #482 ships. Flyway renames the column on start-up."),
            new Step("recon", "16:55", "Reconciliation fails",
                    "16:55. Finance's reconciliation job starts failing.",
                    "Finance's reconciliation job breaks. Nobody touched it, but it reads that column."),
            new Step("rollback", "16:58", "Roll back",
                    "16:58. Roll back ledger-service to v1. The rollback button works; the service doesn't.",
                    "So on-call presses rollback. The old code won't even start: the column it needs is gone."),
            new Step("backlog", "17:00", "Backlog builds",
                    "17:00–17:25. Settlements keep coming. settlement-service is still v2.",
                    "Meanwhile settlements keep arriving. They queue on Kafka, in the new format."),
            new Step("hotfix", "17:25", "Hand hotfix",
                    "17:25. A DBA reverses V3 by hand so v1 can start again.",
                    "A DBA reverses V3 by hand. v1 comes back up and drains the queue."),
            new Step("zero", "17:26", "£0.00",
                    "17:26. Incident closed. Every dashboard is green.",
                    "Every dashboard is green. And fifty settlements are booked at £0.00. No exception. "
                            + "Nothing in the dead-letter queue."));

    private final Ops ops;
    private volatile int next;
    private volatile String stepStatus = "idle";
    private volatile Map<String, Object> result;
    private BigDecimal backlogTotal = BigDecimal.ZERO;

    public Incident(Ops ops) {
        this.ops = ops;
    }

    public int next() {
        return next;
    }

    public String stepStatus() {
        return stepStatus;
    }

    public Map<String, Object> result() {
        return result;
    }

    public void restart() {
        next = 0;
        result = null;
        stepStatus = "idle";
        ops.events.publish("incident", Map.of("next", 0, "status", "idle"));
    }

    /** Runs all remaining steps. Returns true if the incident reproduced exactly as described. */
    public boolean runAll() {
        while (next < STEPS.size()) {
            if (!runNext()) {
                return false;
            }
        }
        return result != null && Boolean.TRUE.equals(result.get("reproduced"));
    }

    /** Runs the next step. Returns false if the step went wrong (not the same as the story's failures). */
    public boolean runNext() {
        if (next >= STEPS.size()) {
            restart();
        }
        int index = next;
        Step step = STEPS.get(index);
        publishStep(index, "running");
        boolean ok;
        try {
            ok = run(index);
        } catch (RuntimeException e) {
            ops.events.fail(e.getMessage());
            ok = false;
        }
        publishStep(index, ok ? "done" : "failed");
        if (ok) {
            next = index + 1;
        }
        return ok;
    }

    private void publishStep(int index, String status) {
        Step s = STEPS.get(index);
        stepStatus = status;
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("scenario", "incident");
        data.put("index", index);
        data.put("total", STEPS.size());
        data.put("id", s.id());
        data.put("time", s.time());
        data.put("title", s.title());
        data.put("caption", s.caption());
        data.put("say", s.say());
        data.put("status", status);
        if (result != null && index == STEPS.size() - 1) {
            data.put("result", result);
        }
        ops.events.publish("step", data);
    }

    private boolean run(int index) {
        var e = ops.events;
        switch (index) {
            case 0 -> {
                result = null;
                ops.down();
                if (!ops.up("main")) {
                    return false;
                }
                ops.traffic.send(10);
                if (!ops.kafka.waitForDrain(60)) {
                    e.warn("ledger-service is still catching up");
                }
                ops.ledgerReport();
            }
            case 1 -> {
                e.say("ledger-service goes first: Flyway runs V3 (rename amount → amount_minor, retype to pence).");
                if (!ops.deploy(ServiceRunner.LEDGER, BAD) || !ops.deploy(ServiceRunner.SETTLEMENT, BAD)) {
                    return false;
                }
                ops.traffic.send(20);
                if (!ops.kafka.waitForDrain(60)) {
                    e.warn("ledger-service is still catching up");
                }
                ops.ledgerReport();
            }
            case 2 -> {
                e.say("Nobody changed reconciliation-batch. It still reads ledger_entries.amount directly.");
                Recon r = ops.recon();
                if (r.error() == null) {
                    e.fail("expected reconciliation to fail against the V3 schema");
                    return false;
                }
                e.say("On-call sees ledger_entries in the stack trace and rolls back the service that owns it.");
            }
            case 3 -> {
                if (ops.rollback(ServiceRunner.LEDGER, "main")) {
                    e.fail("expected v1 to fail against the V3 schema");
                    return false;
                }
                e.say("v1 expects a column called amount. V3 renamed it. Flyway can't undo it: there is no undo.");
            }
            case 4 -> {
                ops.traffic.send(50);
                backlogTotal = ops.traffic.lastTotal(50);
                e.say("These 50 events (£" + backlogTotal.toPlainString()
                        + ") carry amountMinor and no amount. ledger-service is down, so they queue.");
                e.say("Backlog on payments.settled: " + ops.kafka.lag() + " events");
            }
            case 5 -> {
                if (!ops.hotfix()) {
                    return false;
                }
                e.say("v1 drains the backlog…");
                if (!ops.kafka.waitForDrain(90)) {
                    e.warn("backlog not fully drained");
                }
            }
            case 6 -> {
                ops.ledgerReport();
                Recon r = ops.recon();
                BigDecimal booked = r.total() == null ? BigDecimal.ZERO : r.total();
                BigDecimal expected = ops.traffic.sentTotal();
                BigDecimal missing = expected.subtract(booked).setScale(2);
                long zero = ops.ledger.zeroCount();
                long dlt = ops.kafka.dlt();
                String health = ops.runner.health(ServiceRunner.LEDGER);
                boolean reproduced = zero == 50 && dlt == 0 && "UP".equals(health) && missing.compareTo(backlogTotal) == 0;

                e.caption("What happened");
                e.say("Reconciliation total: £" + booked.toPlainString() + ". Settlements sent: £" + expected.toPlainString()
                        + ". £" + missing.toPlainString() + " is missing.");
                e.say(zero + " settlements were booked at £0.00. No exception. Nothing in the dead-letter topic (" + dlt + " records).");
                e.say("Why: v1 reads the v2 events by field name. Jackson ignores the unknown amountMinor,");
                e.say("and the missing primitive 'double amount' quietly stays 0.0.");
                e.say("Rolling back the code didn't roll back the database or the events already on the topic.");
                e.say("PR #482 was a one-way door.");

                Map<String, Object> res = new LinkedHashMap<>();
                res.put("booked", booked);
                res.put("sent", expected);
                res.put("missing", missing);
                res.put("zeroRows", zero);
                res.put("dlt", dlt);
                res.put("ledgerHealth", health);
                res.put("backlogTotal", backlogTotal);
                res.put("reproduced", reproduced);
                result = res;
                if (reproduced) {
                    e.ok("Reproduced: 50 rows at £0.00, empty DLT, ledger-service healthy.");
                } else {
                    e.fail("Did not reproduce cleanly: zero=" + zero + " dlt=" + dlt + " health=" + health + " missing=£"
                            + missing.toPlainString() + " (expected £" + backlogTotal.toPlainString() + ").");
                }
            }
            default -> throw new IllegalStateException("no step " + index);
        }
        return true;
    }
}
