package onewaydoor.controlcentre.scenario;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import org.springframework.stereotype.Component;

import onewaydoor.controlcentre.events.EventBus;

/** One thing at a time: every action from the UI runs here, in order, so two clicks can't race each other. */
@Component
public class ScenarioRunner {

    public interface Job {
        void run() throws Exception;
    }

    private final ExecutorService executor = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "scenario");
        t.setDaemon(true);
        return t;
    });
    private final EventBus events;
    private volatile String busy;

    public ScenarioRunner(EventBus events) {
        this.events = events;
    }

    /** Starts the job unless another one is running. Returns false if busy. */
    public synchronized boolean submit(String name, Job job) {
        if (busy != null) {
            return false;
        }
        busy = name;
        events.publish("busy", java.util.Map.of("name", name));
        executor.submit(() -> {
            try {
                job.run();
            } catch (Exception e) {
                events.fail(name + ": " + (e.getMessage() == null ? e.toString() : e.getMessage()));
            } finally {
                busy = null;
                events.publish("busy", java.util.Map.of());
            }
        });
        return true;
    }

    /** Runs a job on the scenario thread and waits for it (headless mode). */
    public <T> T runAndWait(java.util.concurrent.Callable<T> job) throws Exception {
        Future<T> f = executor.submit(job);
        return f.get();
    }

    public String busy() {
        return busy;
    }
}
