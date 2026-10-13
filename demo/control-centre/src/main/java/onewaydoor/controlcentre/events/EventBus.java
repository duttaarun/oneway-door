package onewaydoor.controlcentre.events;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;

/**
 * Everything the UI sees arrives through here as a typed event: log lines, story steps, observed Kafka events,
 * rollback-test stages and state snapshots. The same stream is printed in headless mode and can be recorded, which
 * is what replay mode plays back.
 */
@Component
public class EventBus {

    public record Event(long t, String type, Object data) {
    }

    private static final int BACKLOG = 400;

    private final ObjectMapper json = new ObjectMapper().findAndRegisterModules()
            .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
    private final List<SseEmitter> emitters = new CopyOnWriteArrayList<>();
    private final Deque<Event> recentLogs = new ArrayDeque<>();
    private final ConsoleSink console = new ConsoleSink();

    private volatile boolean echoToConsole;
    private volatile List<Event> recording;
    private volatile long recordingStart;

    public SseEmitter subscribe() {
        SseEmitter emitter = new SseEmitter(0L);
        emitters.add(emitter);
        emitter.onCompletion(() -> emitters.remove(emitter));
        emitter.onTimeout(() -> emitters.remove(emitter));
        emitter.onError(e -> emitters.remove(emitter));
        List<Event> backlog;
        synchronized (recentLogs) {
            backlog = new ArrayList<>(recentLogs);
        }
        for (Event e : backlog) {
            send(emitter, e);
        }
        return emitter;
    }

    public boolean hasSubscribers() {
        return !emitters.isEmpty() || recording != null;
    }

    public void publish(String type, Object data) {
        Event event = new Event(System.currentTimeMillis(), type, data);
        if ("log".equals(type) || "step".equals(type)) {
            synchronized (recentLogs) {
                recentLogs.addLast(event);
                while (recentLogs.size() > BACKLOG) {
                    recentLogs.removeFirst();
                }
            }
        }
        List<Event> rec = recording;
        if (rec != null) {
            synchronized (rec) {
                rec.add(new Event(event.t() - recordingStart, type, data));
            }
        }
        if (echoToConsole) {
            console.print(type, data);
        }
        for (SseEmitter emitter : emitters) {
            send(emitter, event);
        }
    }

    private void send(SseEmitter emitter, Event event) {
        try {
            emitter.send(SseEmitter.event().name(event.type()).data(json.writeValueAsString(event)));
        } catch (IOException | IllegalStateException e) {
            emitters.remove(emitter);
        }
    }

    // ---------- convenience: log lines ----------

    public void info(String text) {
        log("info", text);
    }

    public void ok(String text) {
        log("ok", "✔ " + text);
    }

    public void warn(String text) {
        log("warn", "! " + text);
    }

    public void fail(String text) {
        log("fail", "✘ " + text);
    }

    public void say(String text) {
        log("say", text);
    }

    public void caption(String text) {
        log("caption", text);
    }

    public void log(String level, String text) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("level", level);
        data.put("text", text);
        publish("log", data);
    }

    public void clearLogs() {
        synchronized (recentLogs) {
            recentLogs.clear();
        }
        publish("clear", Map.of());
    }

    // ---------- recording ----------

    public void startRecording() {
        recordingStart = System.currentTimeMillis();
        recording = new ArrayList<>();
    }

    /** Stops recording and writes {meta, events} to the given file. */
    public void stopRecording(Path file, Map<String, Object> meta) throws IOException {
        List<Event> rec = recording;
        recording = null;
        if (rec == null) {
            return;
        }
        Map<String, Object> doc = new LinkedHashMap<>(meta);
        doc.put("recordedAt", Instant.now().toString());
        synchronized (rec) {
            doc.put("events", new ArrayList<>(rec));
        }
        Files.createDirectories(file.getParent());
        json.writerWithDefaultPrettyPrinter().writeValue(file.toFile(), doc);
    }

    @jakarta.annotation.PreDestroy
    public void closeStreams() {
        for (SseEmitter emitter : emitters) {
            try {
                emitter.complete();
            } catch (RuntimeException ignored) {
                // already gone
            }
        }
        emitters.clear();
    }

    public void echoToConsole(boolean on) {
        echoToConsole = on;
    }

    public ObjectMapper json() {
        return json;
    }
}
