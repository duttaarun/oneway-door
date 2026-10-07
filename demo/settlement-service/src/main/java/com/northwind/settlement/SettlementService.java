package com.northwind.settlement;

import java.time.Clock;
import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.ExecutionException;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Service;

@Service
public class SettlementService {

    private final KafkaTemplate<String, PaymentSettled> kafka;
    private final String topic;
    private final Clock clock;

    public SettlementService(KafkaTemplate<String, PaymentSettled> kafka,
                             @Value("${northwind.topics.payments-settled}") String topic,
                             Clock clock) {
        this.kafka = kafka;
        this.topic = topic;
        this.clock = clock;
    }

    public PaymentSettled settle(SettlementRequest request) {
        PaymentSettled event = toEvent(request, UUID.randomUUID());
        try {
            // Wait for the broker ack so a 202 means the event is on the topic.
            kafka.send(topic, event.paymentId().toString(), event).get();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted publishing " + event.paymentId(), e);
        } catch (ExecutionException e) {
            throw new IllegalStateException("Could not publish " + event.paymentId(), e.getCause());
        }
        return event;
    }

    PaymentSettled toEvent(SettlementRequest request, UUID paymentId) {
        Instant settledAt = request.settledAt() != null ? request.settledAt() : clock.instant();
        return new PaymentSettled(
                paymentId,
                request.merchantId(),
                request.currency(),
                request.amount().doubleValue(),
                settledAt);
    }
}
