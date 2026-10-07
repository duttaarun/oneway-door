package com.northwind.ledger;

import java.time.Clock;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

@Component
public class PaymentSettledListener {

    private static final Logger log = LoggerFactory.getLogger(PaymentSettledListener.class);

    private final LedgerEntryRepository entries;
    private final Clock clock;

    public PaymentSettledListener(LedgerEntryRepository entries, Clock clock) {
        this.entries = entries;
        this.clock = clock;
    }

    @Transactional
    @KafkaListener(topics = "${northwind.topics.payments-settled}")
    public void on(PaymentSettled event) {
        if (entries.existsByPaymentId(event.paymentId())) {
            log.info("Already booked {}, skipping", event.paymentId());
            return;
        }
        LedgerEntry entry = entries.save(LedgerEntry.from(event, clock.instant()));
        log.info("Booked {} {} {} for {}", entry.getPaymentId(), entry.getCurrency(), entry.getAmount(),
                entry.getMerchantId());
    }
}
