package com.northwind.settlement;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.UUID;

import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule;

class SettlementServiceTest {

    private static final Instant NOW = Instant.parse("2026-10-03T16:40:00Z");
    private final SettlementService service =
            new SettlementService(null, "payments.settled", Clock.fixed(NOW, ZoneOffset.UTC));

    @Test
    void mapsRequestToEvent() {
        UUID id = UUID.randomUUID();
        PaymentSettled event = service.toEvent(
                new SettlementRequest("merchant-0042", "GBP", new BigDecimal("12.34"), null), id);

        assertThat(event.paymentId()).isEqualTo(id);
        assertThat(event.merchantId()).isEqualTo("merchant-0042");
        assertThat(event.currency()).isEqualTo("GBP");
        assertThat(event.amount()).isEqualTo(12.34);
        assertThat(event.settledAt()).isEqualTo(NOW);
    }

    @Test
    void keepsSettledAtWhenGiven() {
        Instant earlier = NOW.minusSeconds(1500);
        PaymentSettled event = service.toEvent(
                new SettlementRequest("merchant-0042", "GBP", BigDecimal.ONE, earlier), UUID.randomUUID());

        assertThat(event.settledAt()).isEqualTo(earlier);
    }

    @Test
    void serialisesTheContractFields() throws Exception {
        ObjectMapper mapper = new ObjectMapper().registerModule(new JavaTimeModule())
                .disable(SerializationFeature.WRITE_DATES_AS_TIMESTAMPS);
        PaymentSettled event = new PaymentSettled(UUID.randomUUID(), "merchant-0042", "GBP", 12.34, NOW);

        JsonNode json = mapper.readTree(mapper.writeValueAsString(event));

        assertThat(json.fieldNames()).toIterable()
                .containsExactlyInAnyOrder("paymentId", "merchantId", "currency", "amount", "settledAt");
        assertThat(json.get("amount").asDouble()).isEqualTo(12.34);
        assertThat(json.get("settledAt").asText()).isEqualTo("2026-10-03T16:40:00Z");
    }
}
