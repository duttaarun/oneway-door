package com.northwind.settlement;

import java.math.BigDecimal;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class SettlementController {

    private final SettlementService settlements;

    public SettlementController(SettlementService settlements) {
        this.settlements = settlements;
    }

    @PostMapping("/settlements")
    public ResponseEntity<?> settle(@RequestBody SettlementRequest request) {
        if (request.merchantId() == null || request.currency() == null
                || request.amount() == null || request.amount().compareTo(BigDecimal.ZERO) <= 0) {
            return ResponseEntity.badRequest().body("merchantId, currency and a positive amount are required");
        }
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(settlements.settle(request));
    }
}
