package onewaydoor.controlcentre.ledger;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import onewaydoor.controlcentre.infra.EmbeddedInfra;

/**
 * Reads ledger_entries the way demo/scripts/ledger.sh did: whatever the schema looks like at the moment
 * (amount, amount_minor or both).
 */
@Component
public class Ledger {

    public record Row(long id, String payment, String merchant, BigDecimal amount, String settledUtc) {
    }

    public record Summary(List<String> columns, long rows, BigDecimal booked, long zero, List<Row> last) {
        public static Summary empty() {
            return new Summary(List.of(), 0, BigDecimal.ZERO, 0, List.of());
        }
    }

    /** Parsed RECON line from reconciliation-batch. A null total means it failed. */
    public record Recon(Long entries, BigDecimal total, Long mismatches, String error, String output) {
    }

    private static final Pattern RECON_OK = Pattern.compile("^RECON (.*)$", Pattern.MULTILINE);
    private static final Pattern KV = Pattern.compile("(\\w+)=([^ ]+)");

    private final EmbeddedInfra infra;

    public Ledger(EmbeddedInfra infra) {
        this.infra = infra;
    }

    private JdbcTemplate jdbc() {
        JdbcTemplate t = new JdbcTemplate(infra.ledgerDb());
        t.setQueryTimeout(3);
        return t;
    }

    public Set<String> columns() {
        return new TreeSet<>(jdbc().queryForList("SELECT column_name FROM information_schema.columns "
                + "WHERE table_name = 'ledger_entries' AND column_name IN ('amount', 'amount_minor')", String.class));
    }

    /** SQL for an entry's amount in pounds, whatever the current schema. Same as amount_expr in lib.sh. */
    public static String amountExpr(Set<String> cols) {
        boolean major = cols.contains("amount");
        boolean minor = cols.contains("amount_minor");
        if (major && minor) {
            return "COALESCE(amount, amount_minor / 100.0)";
        }
        if (major) {
            return "amount";
        }
        if (minor) {
            return "amount_minor / 100.0";
        }
        return "NULL::numeric";
    }

    /** SQL for "booked at £0.00". Same as zero_condition in lib.sh. */
    public static String zeroCondition(Set<String> cols) {
        List<String> parts = new ArrayList<>();
        if (cols.contains("amount")) {
            parts.add("amount = 0");
        }
        if (cols.contains("amount_minor")) {
            parts.add("amount_minor = 0");
        }
        return parts.isEmpty() ? "false" : String.join(" OR ", parts);
    }

    public Summary summary(int limit) {
        Set<String> cols = columns();
        if (cols.isEmpty()) {
            return Summary.empty();
        }
        JdbcTemplate jdbc = jdbc();
        String amount = amountExpr(cols);
        List<Row> last = jdbc.query("SELECT id, left(payment_id::text, 8) AS payment, merchant_id, " + amount + " AS amt, "
                + "to_char(settled_at AT TIME ZONE 'UTC', 'HH24:MI:SS') AS settled FROM ledger_entries ORDER BY id DESC LIMIT ?",
                (rs, i) -> new Row(rs.getLong(1), rs.getString(2), rs.getString(3),
                        rs.getBigDecimal(4) == null ? null : rs.getBigDecimal(4).setScale(2, java.math.RoundingMode.HALF_UP),
                        rs.getString(5)), limit);
        Map<String, Object> agg = jdbc.queryForMap("SELECT count(*) AS n, COALESCE(sum(" + amount + "), 0) AS total, "
                + "count(*) FILTER (WHERE " + zeroCondition(cols) + ") AS zero FROM ledger_entries");
        BigDecimal booked = ((BigDecimal) agg.get("total")).setScale(2, java.math.RoundingMode.HALF_UP);
        return new Summary(List.copyOf(cols), ((Number) agg.get("n")).longValue(), booked,
                ((Number) agg.get("zero")).longValue(), last);
    }

    public long rowCount() {
        Set<String> cols = columns();
        return cols.isEmpty() ? 0 : jdbc().queryForObject("SELECT count(*) FROM ledger_entries", Long.class);
    }

    public long zeroCount() {
        Set<String> cols = columns();
        return cols.isEmpty() ? 0
                : jdbc().queryForObject("SELECT count(*) FROM ledger_entries WHERE " + zeroCondition(cols), Long.class);
    }

    public boolean hasColumn(String column) {
        return columns().contains(column);
    }

    /** Runs a SQL script (the hotfix file) as northwind. */
    public void runScript(String sql) {
        jdbc().execute(sql);
    }

    public static Recon parseRecon(String output) {
        Matcher m = RECON_OK.matcher(output == null ? "" : output);
        String last = null;
        while (m.find()) {
            last = m.group(1);
        }
        if (last == null) {
            return new Recon(null, null, null, "no RECON line in the output", output);
        }
        if (last.startsWith("error=")) {
            return new Recon(null, null, null, last.substring("error=".length()), output);
        }
        Map<String, String> kv = new LinkedHashMap<>();
        Matcher k = KV.matcher(last);
        while (k.find()) {
            kv.put(k.group(1), k.group(2));
        }
        return new Recon(
                kv.containsKey("entries") ? Long.valueOf(kv.get("entries")) : null,
                kv.containsKey("total") ? new BigDecimal(kv.get("total")) : null,
                kv.containsKey("mismatches") ? Long.valueOf(kv.get("mismatches")) : null,
                null, output);
    }
}
