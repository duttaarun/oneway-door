package onewaydoor.controlcentre.ledger;

import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.admin.ListOffsetsResult.ListOffsetsResultInfo;
import org.apache.kafka.clients.admin.OffsetSpec;
import org.apache.kafka.clients.consumer.OffsetAndMetadata;
import org.apache.kafka.common.TopicPartition;
import org.springframework.stereotype.Component;

import onewaydoor.controlcentre.infra.EmbeddedInfra;

/** Topic end offsets, the ledger-service backlog (consumer lag) and the dead-letter count. */
@Component
public class KafkaStats {

    private static final TopicPartition SETTLED = new TopicPartition(EmbeddedInfra.TOPIC, 0);
    private static final TopicPartition DLT = new TopicPartition(EmbeddedInfra.DLT, 0);

    private final EmbeddedInfra infra;

    public KafkaStats(EmbeddedInfra infra) {
        this.infra = infra;
    }

    public long endOffset(TopicPartition tp) {
        try {
            Map<TopicPartition, ListOffsetsResultInfo> r = infra.admin().listOffsets(Map.of(tp, OffsetSpec.latest()))
                    .all().get(5, TimeUnit.SECONDS);
            return r.get(tp).offset();
        } catch (Exception e) {
            return 0;
        }
    }

    public long published() {
        return endOffset(SETTLED);
    }

    public long dlt() {
        return endOffset(DLT);
    }

    /** Events on payments.settled that ledger-service hasn't consumed yet. */
    public long lag() {
        long end = published();
        try {
            Admin admin = infra.admin();
            Map<TopicPartition, OffsetAndMetadata> committed = admin
                    .listConsumerGroupOffsets(EmbeddedInfra.LEDGER_GROUP).partitionsToOffsetAndMetadata()
                    .get(5, TimeUnit.SECONDS);
            OffsetAndMetadata c = committed == null ? null : committed.get(SETTLED);
            return Math.max(0, end - (c == null ? 0 : c.offset()));
        } catch (Exception e) {
            return end;
        }
    }

    /** Waits until ledger-service has consumed everything on the topic. */
    public boolean waitForDrain(int timeoutSec) {
        long deadline = System.currentTimeMillis() + timeoutSec * 1000L;
        while (System.currentTimeMillis() < deadline) {
            if (lag() == 0) {
                return true;
            }
            try {
                Thread.sleep(500);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
        return false;
    }

    public static List<TopicPartition> partitions() {
        return List.of(SETTLED, DLT);
    }
}
