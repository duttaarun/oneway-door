package com.northwind.ledger;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.springframework.kafka.support.serializer.JsonDeserializer;

class PaymentSettledTest {

    private static final Instant SETTLED = Instant.parse("2026-10-03T16:40:00Z");

    @Test
    void deserialisesTheContractPayload() {
        PaymentSettled event = deserialise("""
                {"paymentId":"7f1c1b8e-2a1d-4a52-9d4e-0c6a3f9b1e01","merchantId":"merchant-0042",
                 "currency":"GBP","amount":12.34,"settledAt":"2026-10-03T16:40:00Z"}
                """);

        assertThat(event.paymentId()).isEqualTo(UUID.fromString("7f1c1b8e-2a1d-4a52-9d4e-0c6a3f9b1e01"));
        assertThat(event.merchantId()).isEqualTo("merchant-0042");
        assertThat(event.amount()).isEqualTo(12.34);
        assertThat(event.settledAt()).isEqualTo(SETTLED);
    }

    @Test
    void booksAmountInPoundsWithTwoDecimals() {
        PaymentSettled event = new PaymentSettled(UUID.randomUUID(), "merchant-0042", "GBP", 12.34, SETTLED);

        LedgerEntry entry = LedgerEntry.from(event, SETTLED.plusSeconds(1));

        assertThat(entry.getAmount()).isEqualByComparingTo(new BigDecimal("12.34"));
        assertThat(entry.getAmount().scale()).isEqualTo(2);
        assertThat(entry.getMerchantId()).isEqualTo("merchant-0042");
    }

    /** Same deserialiser settings as application.yml. */
    private static PaymentSettled deserialise(String json) {
        try (JsonDeserializer<PaymentSettled> deserializer = new JsonDeserializer<>()) {
            deserializer.configure(Map.of(
                    JsonDeserializer.USE_TYPE_INFO_HEADERS, false,
                    JsonDeserializer.VALUE_DEFAULT_TYPE, PaymentSettled.class.getName(),
                    JsonDeserializer.TRUSTED_PACKAGES, "com.northwind.ledger"), false);
            return deserializer.deserialize("payments.settled", json.getBytes(StandardCharsets.UTF_8));
        }
    }
}
