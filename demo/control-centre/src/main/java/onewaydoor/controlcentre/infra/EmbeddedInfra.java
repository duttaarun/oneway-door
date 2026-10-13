package onewaydoor.controlcentre.infra;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.AclEntry;
import java.nio.file.attribute.AclEntryFlag;
import java.nio.file.attribute.AclEntryPermission;
import java.nio.file.attribute.AclEntryType;
import java.nio.file.attribute.AclFileAttributeView;
import java.nio.file.attribute.UserPrincipal;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import javax.sql.DataSource;

import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.admin.AdminClientConfig;
import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.clients.admin.OffsetSpec;
import org.apache.kafka.clients.admin.RecordsToDelete;
import org.apache.kafka.common.TopicPartition;
import org.postgresql.ds.PGSimpleDataSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.kafka.test.EmbeddedKafkaBroker;
import org.springframework.kafka.test.EmbeddedKafkaKraftBroker;
import org.springframework.stereotype.Component;

import io.zonky.test.db.postgres.embedded.EmbeddedPostgres;
import jakarta.annotation.PreDestroy;

/**
 * Real PostgreSQL 16 and a real Kafka broker (KRaft), both inside this JVM's control: what docker-compose.yml
 * gave us, without Docker. Starts in the background so the UI (and replay mode) work even if a laptop blocks it.
 */
@Component
public class EmbeddedInfra {

    public static final String TOPIC = "payments.settled";
    public static final String DLT = "payments.settled.DLT";
    public static final String LEDGER_GROUP = "ledger-service";

    private static final Logger log = LoggerFactory.getLogger(EmbeddedInfra.class);

    public enum Status { STARTING, UP, FAILED, STOPPED }

    private final Workspace workspace;
    private final int pgPort;
    private final int kafkaPort;
    private final CompletableFuture<Void> ready = new CompletableFuture<>();

    private volatile Status status = Status.STARTING;
    private volatile String failure;
    private EmbeddedPostgres postgres;
    private EmbeddedKafkaBroker kafka;
    private Admin admin;
    private PGSimpleDataSource ledgerDb;

    public EmbeddedInfra(Workspace workspace, @Value("${owd.pg-port:55432}") int pgPort,
            @Value("${owd.kafka-port:9092}") int kafkaPort) {
        this.workspace = workspace;
        this.pgPort = pgPort;
        this.kafkaPort = kafkaPort;
        Thread starter = new Thread(this::start, "infra-start");
        starter.setDaemon(true);
        starter.start();
    }

    private void start() {
        try {
            stopOrphanPostgres();
            long t0 = System.nanoTime();
            prepareDataDirectory(workspace.state("pgdata"));
            postgres = EmbeddedPostgres.builder()
                    .setPort(pgPort)
                    .setDataDirectory(workspace.state("pgdata"))
                    .setCleanDataDirectory(true)
                    .setOverrideWorkingDirectory(workspace.state("pg-bin").toFile())
                    .setPGStartupWait(Duration.ofSeconds(60))
                    .start();
            try (Connection c = postgres.getPostgresDatabase().getConnection(); Statement st = c.createStatement()) {
                st.execute("CREATE ROLE northwind LOGIN PASSWORD 'northwind'");
            }
            createLedgerDatabase();
            ledgerDb = new PGSimpleDataSource();
            ledgerDb.setURL(jdbcUrl());
            ledgerDb.setUser("northwind");
            ledgerDb.setPassword("northwind");
            log.info("PostgreSQL 16 up on localhost:{} in {} ms", pgPort, (System.nanoTime() - t0) / 1_000_000);

            long t1 = System.nanoTime();
            // The KRaft test kit ignores kafkaPorts(); a fixed EXTERNAL listener gives the services a known port.
            kafka = new EmbeddedKafkaKraftBroker(1, 1)
                    .brokerProperties(Map.of(
                            "listeners", "EXTERNAL://localhost:" + kafkaPort + ",CONTROLLER://localhost:0",
                            "auto.create.topics.enable", "false",
                            "group.initial.rebalance.delay.ms", "0",
                            "offsets.topic.replication.factor", "1",
                            "transaction.state.log.replication.factor", "1",
                            "transaction.state.log.min.isr", "1"));
            kafka.afterPropertiesSet();
            Properties props = new Properties();
            props.put(AdminClientConfig.BOOTSTRAP_SERVERS_CONFIG, kafkaBootstrap());
            admin = Admin.create(props);
            createTopics();
            log.info("Kafka (KRaft) up on {} in {} ms", kafkaBootstrap(), (System.nanoTime() - t1) / 1_000_000);
            status = Status.UP;
            ready.complete(null);
        } catch (Throwable e) {
            failure = rootMessage(e);
            status = Status.FAILED;
            log.error("Infrastructure failed to start: {}", failure, e);
            ready.completeExceptionally(e);
        }
    }

    /**
     * On Windows, initdb gives up administrator rights before it runs. If this JVM runs as an administrator, a data
     * directory it creates belongs to the Administrators group, and initdb then fails with "could not change
     * permissions of directory ... Permission denied". zonky always creates the directory itself, just before
     * initdb, so we create it first and give the current user full control of it. initdb keeps the user's
     * identity when it drops administrator rights, so that entry still lets it in.
     */
    private static void prepareDataDirectory(Path dir) throws IOException {
        if (!Workspace.WINDOWS) {
            return;
        }
        Files.createDirectories(dir);
        AclFileAttributeView view = Files.getFileAttributeView(dir, AclFileAttributeView.class);
        UserPrincipal me = currentWindowsUser(dir);
        if (view == null || me == null) {
            return;
        }
        AclEntry fullControl = AclEntry.newBuilder()
                .setType(AclEntryType.ALLOW)
                .setPrincipal(me)
                .setPermissions(EnumSet.allOf(AclEntryPermission.class))
                .setFlags(AclEntryFlag.FILE_INHERIT, AclEntryFlag.DIRECTORY_INHERIT)
                .build();
        List<AclEntry> acl = new ArrayList<>(view.getAcl());
        acl.add(0, fullControl);
        view.setAcl(acl);
    }

    /** The signed-in Windows user: DOMAIN\name first (a domain or the computer), then the bare name. */
    private static UserPrincipal currentWindowsUser(Path anyPath) {
        var lookup = anyPath.getFileSystem().getUserPrincipalLookupService();
        String name = System.getProperty("user.name");
        String domain = System.getenv("USERDOMAIN");
        for (String candidate : domain == null ? List.of(name) : List.of(domain + "\\" + name, name)) {
            try {
                return lookup.lookupPrincipalByName(candidate);
            } catch (IOException e) {
                log.debug("no Windows account named {}: {}", candidate, e.getMessage());
            }
        }
        log.warn("Couldn't find the Windows account {}; initdb may be refused the data directory", name);
        return null;
    }

    /**
     * A Control Centre killed outright (a closed console window on Windows) leaves its postgres running on our port.
     * Its pid is the first line of postmaster.pid in our data directory.
     */
    private void stopOrphanPostgres() {
        java.nio.file.Path pidFile = workspace.state("pgdata", "postmaster.pid");
        try {
            if (!java.nio.file.Files.exists(pidFile)) {
                return;
            }
            long pid = Long.parseLong(java.nio.file.Files.readAllLines(pidFile).get(0).strip());
            ProcessHandle.of(pid).filter(ProcessHandle::isAlive)
                    .filter(h -> h.info().command().map(c -> c.toLowerCase().contains("postgres")).orElse(false))
                    .ifPresent(h -> {
                        log.info("Stopping a PostgreSQL left over from an earlier run (pid {})", pid);
                        h.destroy();
                        h.onExit().completeOnTimeout(h, 10, TimeUnit.SECONDS).join();
                        if (h.isAlive()) {
                            h.destroyForcibly();
                        }
                    });
        } catch (Exception e) {
            log.debug("orphan check: {}", e.getMessage());
        }
    }

    /** Blocks until Postgres and Kafka are up; throws if they failed. */
    public void awaitUp() {
        try {
            ready.get(5, TimeUnit.MINUTES);
        } catch (Exception e) {
            throw new IllegalStateException("Postgres/Kafka are not available: " + (failure == null ? e.getMessage() : failure));
        }
    }

    /** A fresh ledger database and fresh topics: what `docker compose down -v` and `up` used to give us. */
    public synchronized void reset() throws Exception {
        awaitUp();
        try (Connection c = postgres.getPostgresDatabase().getConnection(); Statement st = c.createStatement()) {
            st.execute("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'ledger' AND pid <> pg_backend_pid()");
            st.execute("DROP DATABASE IF EXISTS ledger");
        }
        createLedgerDatabase();

        Set<String> groups = admin.listConsumerGroups().all().get(10, TimeUnit.SECONDS).stream()
                .map(g -> g.groupId()).collect(java.util.stream.Collectors.toSet());
        if (!groups.isEmpty()) {
            admin.deleteConsumerGroups(groups).all().get(10, TimeUnit.SECONDS);
        }
        Set<String> existing = admin.listTopics().names().get(10, TimeUnit.SECONDS);
        List<String> ours = existing.stream().filter(t -> t.equals(TOPIC) || t.equals(DLT)).toList();
        if (Workspace.WINDOWS && ours.size() == 2) {
            emptyTopics();
            return;
        }
        if (!ours.isEmpty()) {
            admin.deleteTopics(ours).all().get(30, TimeUnit.SECONDS);
            long deadline = System.currentTimeMillis() + 30_000;
            while (System.currentTimeMillis() < deadline
                    && admin.listTopics().names().get(10, TimeUnit.SECONDS).stream().anyMatch(ours::contains)) {
                Thread.sleep(200);
            }
        }
        createTopics();
    }

    /**
     * Windows can't delete a Kafka topic: the broker renames the partition's folder while its files are open, the
     * rename fails with AccessDeniedException, and the broker takes the whole log directory offline. So on Windows a
     * reset empties the topics in place instead: their start moves to their end, and no file is renamed.
     */
    private void emptyTopics() throws Exception {
        Map<TopicPartition, OffsetSpec> latest = Map.of(
                new TopicPartition(TOPIC, 0), OffsetSpec.latest(), new TopicPartition(DLT, 0), OffsetSpec.latest());
        Map<TopicPartition, RecordsToDelete> before = new java.util.HashMap<>();
        admin.listOffsets(latest).all().get(10, TimeUnit.SECONDS)
                .forEach((tp, info) -> before.put(tp, RecordsToDelete.beforeOffset(info.offset())));
        admin.deleteRecords(before).all().get(30, TimeUnit.SECONDS);
    }

    private void createLedgerDatabase() throws SQLException {
        try (Connection c = postgres.getPostgresDatabase().getConnection(); Statement st = c.createStatement()) {
            st.execute("CREATE DATABASE ledger OWNER northwind");
        }
    }

    private void createTopics() throws Exception {
        long deadline = System.currentTimeMillis() + 30_000;
        while (true) {
            try {
                admin.createTopics(List.of(new NewTopic(TOPIC, 1, (short) 1), new NewTopic(DLT, 1, (short) 1)))
                        .all().get(30, TimeUnit.SECONDS);
                return;
            } catch (java.util.concurrent.ExecutionException e) {
                // Straight after a delete the broker can still be removing the old topic.
                if (System.currentTimeMillis() > deadline) {
                    throw e;
                }
                Thread.sleep(300);
            }
        }
    }

    @PreDestroy
    public synchronized void stop() {
        if (admin != null) {
            admin.close(Duration.ofSeconds(5));
        }
        if (kafka != null) {
            try {
                kafka.destroy();
            } catch (Exception e) {
                log.warn("Kafka stop: {}", e.getMessage());
            }
        }
        if (postgres != null) {
            try {
                postgres.close();
            } catch (Exception e) {
                log.warn("Postgres stop: {}", e.getMessage());
            }
        }
        status = Status.STOPPED;
    }

    public Status status() {
        return status;
    }

    public String failure() {
        return failure;
    }

    public Admin admin() {
        awaitUp();
        return admin;
    }

    public DataSource ledgerDb() {
        awaitUp();
        return ledgerDb;
    }

    public String jdbcUrl() {
        return "jdbc:postgresql://localhost:" + pgPort + "/ledger";
    }

    public String kafkaBootstrap() {
        return "localhost:" + kafkaPort;
    }

    public int pgPort() {
        return pgPort;
    }

    public int kafkaPort() {
        return kafkaPort;
    }

    static String rootMessage(Throwable e) {
        Throwable t = e;
        while (t.getCause() != null && t.getCause() != t) {
            t = t.getCause();
        }
        return t.getClass().getSimpleName() + ": " + t.getMessage();
    }
}
