package com.northwind.ledger;

import java.time.Instant;
import java.util.UUID;

/**
 * Consumer-side view of the event on {@code payments.settled}.
 * Contract: contracts/events/payment-settled.schema.json
 *
 * @param amountMinor settled amount in minor units (pence), e.g. 1234 for £12.34
 */
public record PaymentSettled(
        UUID paymentId,
        String merchantId,
        String currency,
        long amountMinor,
        Instant settledAt) {
}
