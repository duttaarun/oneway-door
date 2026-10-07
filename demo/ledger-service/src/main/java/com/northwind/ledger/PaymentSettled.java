package com.northwind.ledger;

import java.time.Instant;
import java.util.UUID;

/**
 * Consumer-side view of the event on {@code payments.settled}.
 * Contract: contracts/events/payment-settled.schema.json
 *
 * <p>amountMinor is boxed on purpose: if it is missing we want a null we can reject,
 * not a primitive that silently reads 0.
 *
 * @param amountMinor settled amount in minor units (pence), e.g. 1234 for £12.34
 */
public record PaymentSettled(
        UUID paymentId,
        String merchantId,
        String currency,
        Long amountMinor,
        Instant settledAt) {
}
