package onewaydoor.controlcentre;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import onewaydoor.controlcentre.infra.Workspace;
import onewaydoor.controlcentre.ledger.Ledger;
import onewaydoor.controlcentre.ledger.Ledger.Recon;
import onewaydoor.controlcentre.runtime.ServiceRunner;
import onewaydoor.controlcentre.scenario.Matrix;

/** The rules ported from the bash scripts, checked without starting Postgres, Kafka or a service. */
class PureLogicTest {

    @Test
    void amountExpressionFollowsTheSchema() {
        assertThat(Ledger.amountExpr(Set.of("amount"))).isEqualTo("amount");
        assertThat(Ledger.amountExpr(Set.of("amount_minor"))).isEqualTo("amount_minor / 100.0");
        assertThat(Ledger.amountExpr(Set.of("amount", "amount_minor"))).isEqualTo("COALESCE(amount, amount_minor / 100.0)");
        assertThat(Ledger.amountExpr(Set.of())).isEqualTo("NULL::numeric");
    }

    @Test
    void zeroConditionCoversEveryAmountColumn() {
        assertThat(Ledger.zeroCondition(Set.of("amount"))).isEqualTo("amount = 0");
        assertThat(Ledger.zeroCondition(Set.of("amount", "amount_minor"))).isEqualTo("amount = 0 OR amount_minor = 0");
        assertThat(Ledger.zeroCondition(Set.of())).isEqualTo("false");
    }

    @Test
    void parsesReconciliationOutput() {
        Recon ok = Ledger.parseRecon("Reconciliation: 80 ledger entries, total £7654.09\nRECON entries=80 total=7654.09\n");
        assertThat(ok.error()).isNull();
        assertThat(ok.entries()).isEqualTo(80L);
        assertThat(ok.total()).isEqualByComparingTo(new BigDecimal("7654.09"));
        assertThat(ok.mismatches()).isNull();

        Recon split = Ledger.parseRecon("RECON entries=20 total=100.00 mismatches=0");
        assertThat(split.mismatches()).isZero();

        Recon failed = Ledger.parseRecon("RECON error=ERROR: column \"amount\" does not exist\n");
        assertThat(failed.total()).isNull();
        assertThat(failed.error()).isEqualTo("ERROR: column \"amount\" does not exist");

        assertThat(Ledger.parseRecon("").error()).isEqualTo("no RECON line in the output");
    }

    @Test
    void findsTheRootCauseOfAFailedStartup() {
        List<String> log = List.of(
                "2026-10-13T19:01:02 ERROR 1 --- [main] o.s.boot.SpringApplication : Application run failed",
                "org.springframework.beans.factory.BeanCreationException: Error creating bean",
                "Caused by: jakarta.persistence.PersistenceException: [PersistenceUnit: default] Unable to build",
                "Caused by: org.hibernate.tool.schema.spi.SchemaManagementException: Schema-validation: missing column [amount] in table [ledger_entries]",
                "\tat org.hibernate.tool.schema.internal.AbstractSchemaValidator.validateTable(AbstractSchemaValidator.java:143)");
        assertThat(ServiceRunner.startupFailure(log))
                .isEqualTo("org.hibernate.tool.schema.spi.SchemaManagementException: Schema-validation: missing column [amount] in table [ledger_entries]");
        assertThat(ServiceRunner.startupFailure(List.of("nothing useful"))).startsWith("exited during start-up");
    }

    @Test
    void matrixMarkdownMatchesTheDocsFormat() {
        List<Map<String, Object>> results = List.of(
                Map.of("from", "main", "to", "split/1-expand", "result", "PASS"),
                new java.util.HashMap<>(Map.of("from", "main", "to", "pr-482-minor-units", "result", "FAIL",
                        "firstProblem", "2 deploy ledger: 20 rows booked at £0.00")));
        String md = Matrix.markdown(results, "2026-10-13 18:00 UTC");
        assertThat(md).startsWith("# Rollback test results\n");
        assertThat(md).contains("| `main` | `split/1-expand` | PASS | **PASS** | none |");
        assertThat(md).contains("| `main` | `pr-482-minor-units` | FAIL | **FAIL** | 2 deploy ledger: 20 rows booked at £0.00 |");
        assertThat(Matrix.expected("pr-482-minor-units")).isEqualTo("FAIL");
        assertThat(Matrix.expected("split/4-drop")).isEqualTo("PASS");
    }

    @Test
    void findsTheRepositoryRootFromASubfolder(@TempDir Path tmp) throws Exception {
        Files.createDirectories(tmp.resolve(".git"));
        Files.createDirectories(tmp.resolve("demo/ledger-service"));
        Path deep = Files.createDirectories(tmp.resolve("demo/control-centre/target"));
        assertThat(Workspace.findRoot(deep)).isEqualTo(tmp);
        assertThatThrownBy(() -> Workspace.findRoot(Files.createDirectories(tmp.getParent().resolve("elsewhere-" + System.nanoTime()))))
                .isInstanceOf(IllegalStateException.class);
    }
}
