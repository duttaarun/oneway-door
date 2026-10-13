package onewaydoor.controlcentre.events;

import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/** Headless mode: prints the event stream the way the old bash scripts printed their output. */
class ConsoleSink {

    private static final boolean COLOUR = System.console() != null && System.getenv("NO_COLOR") == null;
    private static final String RESET = "\033[0m";

    private final PrintStream out = new PrintStream(System.out, true, StandardCharsets.UTF_8);

    void print(String type, Object data) {
        if (!(data instanceof Map<?, ?> map)) {
            return;
        }
        switch (type) {
            case "log" -> line(String.valueOf(map.get("level")), String.valueOf(map.get("text")));
            case "step" -> {
                if ("running".equals(map.get("status"))) {
                    line("caption", map.get("caption") + "");
                }
            }
            case "stage" -> line("info", "  stage " + map.get("stage") + ": " + (Boolean.TRUE.equals(map.get("ok")) ? "ok" : "FAIL"));
            default -> {
            }
        }
    }

    private void line(String level, String text) {
        String colour = switch (level) {
            case "ok" -> "\033[32m";
            case "warn" -> "\033[33m";
            case "fail" -> "\033[31m";
            case "caption" -> "\033[1;36m";
            case "info" -> "\033[2m";
            default -> "";
        };
        String body = "caption".equals(level) ? "\n━━ " + text : ("say".equals(level) ? "  " + text : text);
        out.println(COLOUR && !colour.isEmpty() ? colour + body + RESET : body);
    }
}
