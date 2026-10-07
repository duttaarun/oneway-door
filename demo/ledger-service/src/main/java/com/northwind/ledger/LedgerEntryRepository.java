package com.northwind.ledger;

import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;

public interface LedgerEntryRepository extends JpaRepository<LedgerEntry, Long> {

    boolean existsByPaymentId(UUID paymentId);
}
