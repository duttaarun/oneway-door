package com.northwind.ledger;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;

@Entity
@Table(name = "ledger_entries")
public class LedgerEntry {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "payment_id", nullable = false, unique = true)
    private UUID paymentId;

    @Column(name = "merchant_id", nullable = false, length = 64)
    private String merchantId;

    @Column(nullable = false, length = 3)
    private String currency;

    @Column(nullable = false, precision = 12, scale = 2)
    private BigDecimal amount;

    /** Same amount in minor units (pence). Written alongside amount until amount is dropped. */
    @Column(name = "amount_minor")
    private Long amountMinor;

    @Column(name = "settled_at", nullable = false)
    private Instant settledAt;

    @Column(name = "booked_at", nullable = false)
    private Instant bookedAt;

    protected LedgerEntry() {
    }

    public static LedgerEntry from(PaymentSettled event, Instant bookedAt) {
        LedgerEntry entry = new LedgerEntry();
        entry.paymentId = event.paymentId();
        entry.merchantId = event.merchantId();
        entry.currency = event.currency();
        long minor = event.minorUnits();
        entry.amountMinor = minor;
        entry.amount = BigDecimal.valueOf(minor, 2);
        entry.settledAt = event.settledAt();
        entry.bookedAt = bookedAt;
        return entry;
    }

    public Long getId() {
        return id;
    }

    public UUID getPaymentId() {
        return paymentId;
    }

    public String getMerchantId() {
        return merchantId;
    }

    public String getCurrency() {
        return currency;
    }

    public BigDecimal getAmount() {
        return amount;
    }

    public Long getAmountMinor() {
        return amountMinor;
    }

    public Instant getSettledAt() {
        return settledAt;
    }

    public Instant getBookedAt() {
        return bookedAt;
    }
}
