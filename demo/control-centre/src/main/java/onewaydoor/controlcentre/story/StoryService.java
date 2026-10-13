package onewaydoor.controlcentre.story;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.springframework.stereotype.Component;

import onewaydoor.controlcentre.build.Builder;
import onewaydoor.controlcentre.build.Git;
import onewaydoor.controlcentre.events.EventBus;
import onewaydoor.controlcentre.infra.Workspace;
import onewaydoor.controlcentre.runtime.ServiceRunner;

/** The facts the acts show, read live from git and from the skill itself. */
@Component
public class StoryService {

    public static final String BAD = "pr-482-minor-units";
    public static final List<String> SPLIT = List.of("split/1-expand", "split/2-migrate", "split/3-contract", "split/4-drop");
    private static final String SKILL = ".github/skills/one-way-door";

    private final Git git;
    private final Workspace workspace;
    private final Builder builder;
    private final EventBus events;

    public StoryService(Git git, Workspace workspace, Builder builder, EventBus events) {
        this.git = git;
        this.workspace = workspace;
        this.builder = builder;
        this.events = events;
    }

    /** Act 1: the innocent PR. */
    public Map<String, Object> act1() {
        Map<String, Object> a = new LinkedHashMap<>();
        a.put("ref", BAD);
        a.put("subject", git.run("log", "-1", "--format=%s", BAD).strip());
        a.put("body", git.run("log", "-1", "--format=%b", BAD).strip());
        a.put("diffStat", git.run("diff", "--stat", "main..." + BAD).stripTrailing());
        a.put("migration", git.tryRun("show", BAD + ":demo/ledger-service/src/main/resources/db/migration/V3__amount_minor_units.sql")
                .orElse("").strip());
        a.put("eventDiff", git.run("diff", "main..." + BAD, "--", "contracts/events/payment-settled.schema.json").strip());
        return a;
    }

    /** Act 3: the review. The worked examples from the skill, plus the scripts run live if Node is installed. */
    public Map<String, Object> act3() {
        Map<String, Object> a = new LinkedHashMap<>();
        String doc = read(workspace.root().resolve(SKILL + "/references/output-format.md"));
        List<String> blocks = new ArrayList<>();
        Matcher m = Pattern.compile("## Worked example[^\\r\\n]*\\R\\R```markdown\\R(.*?)\\R```", Pattern.DOTALL).matcher(doc);
        while (m.find()) {
            blocks.add(m.group(1));
        }
        a.put("oneWay", blocks.isEmpty() ? "" : blocks.get(0));
        a.put("twoWay", blocks.size() > 1 ? blocks.get(1) : "");
        a.put("skillPath", SKILL + "/SKILL.md");
        String node = nodeVersion();
        a.put("node", node);
        if (node != null) {
            a.put("scanMigrations", runScript("scan-migrations.mjs", "main", BAD));
            a.put("schemaCompat", runScript("schema-compat.mjs", "main", BAD));
        }
        return a;
    }

    /** Act 4: the split, as four real branches. */
    public Map<String, Object> act4() {
        List<Map<String, Object>> steps = new ArrayList<>();
        String prev = "main";
        for (String ref : SPLIT) {
            Map<String, Object> s = new LinkedHashMap<>();
            s.put("ref", ref);
            s.put("exists", git.exists(ref));
            if (git.exists(ref)) {
                s.put("subject", git.run("log", "-1", "--format=%s", ref).strip());
                s.put("body", git.run("log", "-1", "--format=%b", ref).strip());
                s.put("diffStat", git.run("diff", "--shortstat", prev + "..." + ref).strip());
                s.put("files", List.of(git.run("diff", "--name-only", prev + "..." + ref).strip().split("\\R")));
            }
            steps.add(s);
            prev = ref;
        }
        Map<String, Object> a = new LinkedHashMap<>();
        a.put("steps", steps);
        String endDiff = git.tryRun("diff", "--stat", BAD, "split/4-drop", "--", "contracts", "demo/settlement-service").orElse("?").strip();
        a.put("sameEndState", endDiff.isEmpty());
        return a;
    }

    /** Runs each service's unit tests at a ref, in a worktree, and reports the counts. */
    public List<Map<String, Object>> runTests(String ref) throws Exception {
        String commit = git.commit(ref);
        Path wt = workspace.state("wt", "test-" + commit.substring(0, 12));
        git.tryRun("worktree", "remove", "--force", wt.toString());
        git.tryRun("worktree", "prune");
        git.run("worktree", "add", "--quiet", "--detach", wt.toString(), commit);
        events.caption("Unit tests at " + ref + " (" + commit.substring(0, 7) + ")");
        List<Map<String, Object>> out = new ArrayList<>();
        try {
            for (String service : List.of(ServiceRunner.SETTLEMENT, ServiceRunner.LEDGER, ServiceRunner.RECON)) {
                events.publish("tests", Map.of("service", service, "status", "running"));
                Path dir = wt.resolve("demo").resolve(service);
                List<String> cmd = new ArrayList<>(builder.mavenCommand(dir, "test"));
                cmd.remove("-q");
                ProcessBuilder pb = new ProcessBuilder(cmd).directory(dir.toFile()).redirectErrorStream(true);
                pb.environment().put("JAVA_HOME", Builder.javaHome());
                Process p = pb.start();
                String log = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
                p.waitFor(10, TimeUnit.MINUTES);
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("service", service);
                r.put("ok", log.contains("BUILD SUCCESS"));
                r.put("summary", testSummary(log));
                r.put("status", log.contains("BUILD SUCCESS") ? "passed" : "failed");
                events.publish("tests", r);
                if (Boolean.TRUE.equals(r.get("ok"))) {
                    events.ok(service + ": " + r.get("summary"));
                } else {
                    events.fail(service + ": " + r.get("summary"));
                }
                out.add(r);
            }
        } finally {
            git.tryRun("worktree", "remove", "--force", wt.toString());
        }
        return out;
    }

    /** The last "Tests run:" totals line Surefire prints, or "no tests". */
    static String testSummary(String log) {
        String last = null;
        for (String line : log.split("\\R")) {
            if (line.matches("^\\[(INFO|ERROR|WARNING)\\] Tests run: .*") && !line.contains(" in ")) {
                last = line.replaceFirst("^\\[[A-Z]+\\] ", "");
            }
        }
        return last == null ? (log.contains("BUILD SUCCESS") ? "no tests" : "build failed") : last;
    }

    private Object runScript(String script, String base, String head) {
        try {
            Process p = new ProcessBuilder(nodeCommand(), workspace.root().resolve(SKILL + "/scripts/" + script).toString(),
                    "--base", base, "--head", head).directory(workspace.root().toFile()).redirectErrorStream(false).start();
            String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
            p.waitFor(60, TimeUnit.SECONDS);
            return events.json().readTree(out);
        } catch (Exception e) {
            return Map.of("error", String.valueOf(e.getMessage()));
        }
    }

    private static String nodeCommand() {
        return Workspace.WINDOWS ? "node.exe" : "node";
    }

    public static String nodeVersion() {
        try {
            Process p = new ProcessBuilder(nodeCommand(), "--version").redirectErrorStream(true).start();
            String v = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8).strip();
            return p.waitFor(10, TimeUnit.SECONDS) && p.exitValue() == 0 ? v : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static String read(Path p) {
        try {
            return Files.readString(p);
        } catch (IOException e) {
            return "";
        }
    }
}
