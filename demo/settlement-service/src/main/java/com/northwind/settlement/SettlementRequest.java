package com.northwind.settlement;

import java.math.BigDecimal;
import java.time.Instant;

/**
 * Body of {@code POST /settlements}.
 *
 * @param amount    amount in major units, e.g. 12.34
 * @param settledAt optional; defaults to now. Lets demo traffic replay a time window quickly.
 */
public record SettlementRequest(
        String merchantId,
        String currency,
        BigDecimal amount,
        Instant settledAt) {
}
