package onewaydoor.controlcentre.api;

import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import onewaydoor.controlcentre.events.EventBus;
import onewaydoor.controlcentre.events.TopicObserver;
import onewaydoor.controlcentre.infra.EmbeddedInfra;
import onewaydoor.controlcentre.ledger.KafkaStats;
import onewaydoor.controlcentre.ledger.Ledger;
import onewaydoor.controlcentre.ledger.Traffic;
import onewaydoor.controlcentre.runtime.ServiceRunner;
import onewaydoor.controlcentre.runtime.ServiceRunner.Deployed;
import onewaydoor.controlcentre.scenario.Incident;
import onewaydoor.controlcentre.scenario.Ops;
import onewaydoor.controlcentre.scenario.ScenarioRunner;

/** A snapshot of the whole system, pushed to the UI every second (and recorded with everything else). */
@Component
public class StateService {

    private final EmbeddedInfra infra;
    private final ServiceRunner runner;
    private final Ledger ledger;
    private final KafkaStats kafka;
    private final Traffic traffic;
    private final TopicObserver observer;
    private final Incident incident;
    private final ScenarioRunner scenarios;
    private final EventBus events;
    private final Ops ops;

    public StateService(EmbeddedInfra infra, ServiceRunner runner, Ledger ledger, KafkaStats kafka, Traffic traffic,
            TopicObserver observer, Incident incident, ScenarioRunner scenarios, EventBus events, Ops ops) {
        this.ops = ops;
        this.infra = infra;
        this.runner = runner;
        this.ledger = ledger;
        this.kafka = kafka;
        this.traffic = traffic;
        this.observer = observer;
        this.incident = incident;
        this.scenarios = scenarios;
        this.events = events;
    }

    @Scheduled(fixedDelay = 1000, initialDelay = 1000)
    public void push() {
        if (events.hasSubscribers()) {
            events.publish("state", snapshot());
        }
    }

    public Map<String, Object> snapshot() {
        Map<String, Object> s = new LinkedHashMap<>();
        Map<String, Object> inf = new LinkedHashMap<>();
        inf.put("status", infra.status().name());
        inf.put("failure", infra.failure());
        inf.put("postgres", "localhost:" + infra.pgPort());
        inf.put("kafka", infra.kafkaBootstrap());
        s.put("infra", inf);
        s.put("busy", scenarios.busy());

        Map<String, Object> services = new LinkedHashMap<>();
        for (String name : ServiceRunner.SERVICES) {
            Map<String, Object> svc = new LinkedHashMap<>();
            Deployed d = runner.deployed(name);
            svc.put("ref", d == null ? null : d.build().ref());
            svc.put("commit", d == null ? null : d.build().shortCommit());
            svc.put("status", d == null ? "STOPPED" : d.status().name());
            svc.put("failure", d == null ? null : d.failure());
            svc.put("port", ServiceRunner.port(name));
            if (!ServiceRunner.RECON.equals(name)) {
                svc.put("health", d == null ? "unreachable" : runner.health(name));
                svc.put("pid", d == null ? null : d.pid());
            }
            services.put(name, svc);
        }
        s.put("services", services);

        if (infra.status() == EmbeddedInfra.Status.UP) {
            try {
                s.put("ledger", ledger.summary(10));
            } catch (RuntimeException e) {
                s.put("ledger", Map.of("error", String.valueOf(e.getMessage())));
            }
            Map<String, Object> k = new LinkedHashMap<>();
            k.put("published", kafka.published());
            k.put("lag", kafka.lag());
            k.put("dlt", kafka.dlt());
            k.put("formats", observer.formats());
            s.put("kafka", k);
        }
        Map<String, Object> t = new LinkedHashMap<>();
        t.put("sent", traffic.sentCount());
        t.put("total", traffic.sentTotal());
        s.put("traffic", t);
        s.put("recon", ops.lastRecon());

        Map<String, Object> inc = new LinkedHashMap<>();
        inc.put("next", incident.next());
        inc.put("status", incident.stepStatus());
        inc.put("result", incident.result());
        s.put("incident", inc);
        return s;
    }
}
