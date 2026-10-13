package onewaydoor.controlcentre.events;

import java.time.Duration;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.atomic.AtomicLong;

import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.common.TopicPartition;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import com.fasterxml.jackson.databind.JsonNode;

import jakarta.annotation.PreDestroy;
import onewaydoor.controlcentre.infra.EmbeddedInfra;

/**
 * Reads every event on payments.settled (no consumer group, so it never affects ledger-service's offsets) and
 * reports its real shape: v1 carries "amount" in pounds, v2 carries "amountMinor" in pence, the split's middle
 * steps carry both. This is what colours the events in the UI.
 */
@Component
public class TopicObserver {

    private static final Logger log = LoggerFactory.getLogger(TopicObserver.class);

    private final EmbeddedInfra infra;
    private final EventBus events;
    private final Map<String, AtomicLong> formats = new LinkedHashMap<>();
    private final Deque<Map<String, Object>> recent = new ArrayDeque<>();
    private volatile boolean resetRequested;
    private volatile boolean running = true;

    public TopicObserver(EmbeddedInfra infra, EventBus events) {
        this.infra = infra;
        this.events = events;
        clearCounts();
        Thread t = new Thread(this::loop, "topic-observer");
        t.setDaemon(true);
        t.start();
    }

    private void loop() {
        try {
            infra.awaitUp();
        } catch (IllegalStateException e) {
            return;
        }
        while (running) {
            resetRequested = false;
            Properties p = new Properties();
            p.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, infra.kafkaBootstrap());
            p.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class.getName());
            p.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class.getName());
            p.put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false");
            p.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
            try (KafkaConsumer<String, String> consumer = new KafkaConsumer<>(p)) {
                TopicPartition tp = new TopicPartition(EmbeddedInfra.TOPIC, 0);
                consumer.assign(List.of(tp));
                consumer.seekToBeginning(List.of(tp));
                while (running && !resetRequested) {
                    for (ConsumerRecord<String, String> r : consumer.poll(Duration.ofMillis(300))) {
                        observe(r);
                    }
                }
            } catch (Exception e) {
                log.debug("observer restarting: {}", e.getMessage());
                sleep(1000);
            }
        }
    }

    private void observe(ConsumerRecord<String, String> r) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("offset", r.offset());
        try {
            JsonNode n = events.json().readTree(r.value());
            boolean major = n.hasNonNull("amount");
            boolean minor = n.hasNonNull("amountMinor");
            String format = major && minor ? "both" : minor ? "v2" : major ? "v1" : "unknown";
            data.put("format", format);
            data.put("merchantId", n.path("merchantId").asText(null));
            if (major) {
                data.put("amount", n.get("amount").decimalValue());
            }
            if (minor) {
                data.put("amountMinor", n.get("amountMinor").asLong());
            }
            data.put("raw", r.value());
            synchronized (formats) {
                formats.computeIfAbsent(format, k -> new AtomicLong()).incrementAndGet();
                recent.addFirst(data);
                while (recent.size() > 6) {
                    recent.removeLast();
                }
            }
        } catch (Exception e) {
            data.put("format", "unreadable");
            data.put("raw", r.value());
        }
        events.publish("observed", data);
    }

    /** After the topic is recreated: start again from offset 0 with empty counts. */
    public void reset() {
        clearCounts();
        resetRequested = true;
    }

    private void clearCounts() {
        synchronized (formats) {
            formats.clear();
            for (String f : List.of("v1", "v2", "both")) {
                formats.put(f, new AtomicLong());
            }
            recent.clear();
        }
    }

    public Map<String, Long> formats() {
        Map<String, Long> out = new LinkedHashMap<>();
        synchronized (formats) {
            formats.forEach((k, v) -> out.put(k, v.get()));
        }
        return out;
    }

    public List<Map<String, Object>> recent() {
        synchronized (formats) {
            return new ArrayList<>(recent);
        }
    }

    @PreDestroy
    public void stop() {
        running = false;
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
