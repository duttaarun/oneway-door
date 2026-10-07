package com.northwind.ledger;

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

    /** Amount in minor units (pence). The legacy amount column is filled by a trigger until it is dropped. */
    @Column(name = "amount_minor", nullable = false)
    private long amountMinor;

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
        if (event.amountMinor() == null) {
            // Fail loudly (the record goes to the dead-letter topic) rather than book £0.00.
            throw new IllegalArgumentException("PaymentSettled " + event.paymentId() + " has no amountMinor");
        }
        entry.amountMinor = event.amountMinor();
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

    public long getAmountMinor() {
        return amountMinor;
    }

    public Instant getSettledAt() {
        return settledAt;
    }

    public Instant getBookedAt() {
        return bookedAt;
    }
}
