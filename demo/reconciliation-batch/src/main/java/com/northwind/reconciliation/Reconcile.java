package com.northwind.reconciliation;

import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;

/**
 * Nightly reconciliation: the ledger total that finance compares with the bank statement.
 * Reads ledger_entries directly; it does not go through ledger-service.
 */
public final class Reconcile {

    public static void main(String[] args) {
        String url = env("DB_URL", "jdbc:postgresql://localhost:5432/ledger");
        try (Connection db = DriverManager.getConnection(url, env("DB_USER", "northwind"), env("DB_PASSWORD", "northwind"));
             Statement st = db.createStatement();
             ResultSet rs = st.executeQuery("""
                     SELECT COUNT(*),
                            COALESCE(SUM(amount), 0),
                            COUNT(*) FILTER (WHERE amount_minor IS DISTINCT FROM round(amount * 100)::bigint)
                     FROM ledger_entries""")) {
            rs.next();
            long entries = rs.getLong(1);
            BigDecimal total = rs.getBigDecimal(2).setScale(2);
            long mismatches = rs.getLong(3);
            System.out.printf("Reconciliation: %d ledger entries, total £%s%n", entries, total.toPlainString());
            // While amount and amount_minor both exist, they must agree before anyone switches to amount_minor.
            if (mismatches > 0) {
                System.out.printf("WARNING: amount and amount_minor disagree on %d entries%n", mismatches);
            }
            System.out.printf("RECON entries=%d total=%s mismatches=%d%n", entries, total.toPlainString(), mismatches);
        } catch (SQLException e) {
            System.out.println("RECON error=" + e.getMessage().lines().findFirst().orElse("unknown"));
            System.err.println("Reconciliation failed: " + e.getMessage());
            System.exit(1);
        }
    }

    private static String env(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }
}
