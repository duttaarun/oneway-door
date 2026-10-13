package onewaydoor.controlcentre.ledger;

import java.math.BigDecimal;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicInteger;

import org.springframework.stereotype.Component;

import onewaydoor.controlcentre.events.EventBus;
import onewaydoor.controlcentre.runtime.ServiceRunner;

/**
 * Fires settlements at settlement-service, 8 at a time. Their settledAt times are 30 s apart and end now, so 50
 * events replay "the last 25 minutes of settlements" in a couple of seconds. Same as demo/scripts/traffic.sh.
 */
@Component
public class Traffic {

    public record Result(int requested, int accepted, BigDecimal total, String firstUtc, String lastUtc, long millis) {
    }

    private static final DateTimeFormatter HHMM = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneOffset.UTC);

    private final ServiceRunner runner;
    private final EventBus events;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
    private final ExecutorService pool = Executors.newFixedThreadPool(8);
    private final List<BigDecimal> sent = new ArrayList<>();

    public Traffic(ServiceRunner runner, EventBus events) {
        this.runner = runner;
        this.events = events;
    }

    public Result send(int count) {
        if (!"UP".equals(runner.health(ServiceRunner.SETTLEMENT))) {
            throw new IllegalStateException("settlement-service is not up");
        }
        int spacing = 30;
        Instant now = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        Instant start = now.minusSeconds((long) count * spacing);
        List<BigDecimal> accepted = new ArrayList<>();
        AtomicInteger failures = new AtomicInteger();
        List<CompletableFuture<Void>> jobs = new ArrayList<>();
        long t0 = System.nanoTime();
        for (int i = 1; i <= count; i++) {
            ThreadLocalRandom rnd = ThreadLocalRandom.current();
            long pence = rnd.nextLong(100, 50_000);                       // £1.00 to £499.99
            BigDecimal amount = BigDecimal.valueOf(pence, 2);
            String merchant = String.format(Locale.ROOT, "merchant-%04d", rnd.nextInt(1, 41));
            String settledAt = start.plusSeconds((long) i * spacing).toString();
            String body = "{\"merchantId\":\"" + merchant + "\",\"currency\":\"GBP\",\"amount\":" + amount.toPlainString()
                    + ",\"settledAt\":\"" + settledAt + "\"}";
            jobs.add(CompletableFuture.runAsync(() -> {
                try {
                    HttpResponse<Void> r = http.send(HttpRequest.newBuilder(URI.create("http://localhost:8081/settlements"))
                            .timeout(Duration.ofSeconds(10)).header("Content-Type", "application/json")
                            .POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.discarding());
                    if (r.statusCode() == 202) {
                        synchronized (accepted) {
                            accepted.add(amount);
                        }
                    } else {
                        failures.incrementAndGet();
                    }
                } catch (Exception e) {
                    failures.incrementAndGet();
                }
            }, pool));
        }
        CompletableFuture.allOf(jobs.toArray(CompletableFuture[]::new)).join();
        long millis = (System.nanoTime() - t0) / 1_000_000;
        BigDecimal total = accepted.stream().reduce(BigDecimal.ZERO, BigDecimal::add).setScale(2);
        synchronized (sent) {
            sent.addAll(accepted);
        }
        Result result = new Result(count, accepted.size(), total, HHMM.format(start.plusSeconds(spacing)), HHMM.format(now), millis);
        if (accepted.size() == count) {
            events.ok(String.format(Locale.ROOT, "sent %d settlements worth £%s (settledAt %s–%s UTC) in %.1fs",
                    count, total.toPlainString(), result.firstUtc(), result.lastUtc(), millis / 1000.0));
        } else {
            events.fail("only " + accepted.size() + " of " + count + " settlements were accepted (£" + total.toPlainString() + ")");
        }
        return result;
    }

    public int sentCount() {
        synchronized (sent) {
            return sent.size();
        }
    }

    public BigDecimal sentTotal() {
        synchronized (sent) {
            return sent.stream().reduce(BigDecimal.ZERO, BigDecimal::add).setScale(2);
        }
    }

    /** Sum of the last n settlements sent. */
    public BigDecimal lastTotal(int n) {
        synchronized (sent) {
            return sent.subList(Math.max(0, sent.size() - n), sent.size()).stream()
                    .reduce(BigDecimal.ZERO, BigDecimal::add).setScale(2);
        }
    }

    public void reset() {
        synchronized (sent) {
            sent.clear();
        }
    }
}
