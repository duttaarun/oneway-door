package com.northwind.settlement;

import java.time.Instant;
import java.util.UUID;

/**
 * Published to {@code payments.settled} once a payment has settled.
 * Contract: contracts/events/payment-settled.schema.json
 *
 * @param amount      settled amount in major units (pounds), e.g. 12.34. Being replaced by amountMinor.
 * @param amountMinor the same amount in minor units (pence), e.g. 1234
 */
public record PaymentSettled(
        UUID paymentId,
        String merchantId,
        String currency,
        double amount,
        long amountMinor,
        Instant settledAt) {
}
