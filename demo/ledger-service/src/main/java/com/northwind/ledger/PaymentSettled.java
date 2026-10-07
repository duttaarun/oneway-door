package com.northwind.ledger;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Instant;
import java.util.UUID;

/**
 * Consumer-side view of the event on {@code payments.settled}.
 * Contract: contracts/events/payment-settled.schema.json
 *
 * @param amount      settled amount in major units (pounds). Being replaced by amountMinor.
 * @param amountMinor settled amount in minor units (pence); null in events from older producers
 */
public record PaymentSettled(
        UUID paymentId,
        String merchantId,
        String currency,
        double amount,
        Long amountMinor,
        Instant settledAt) {

    /** The amount in minor units: the new field when the producer sent it, otherwise the old one. */
    public long minorUnits() {
        if (amountMinor != null) {
            return amountMinor;
        }
        return BigDecimal.valueOf(amount).movePointRight(2).setScale(0, RoundingMode.HALF_UP).longValueExact();
    }
}
