package com.northwind.ledger;

import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.Map;

import org.apache.kafka.common.serialization.ByteArraySerializer;
import org.apache.kafka.common.serialization.Serializer;
import org.apache.kafka.common.serialization.StringSerializer;
import org.springframework.boot.autoconfigure.kafka.KafkaProperties;
import org.springframework.boot.ssl.SslBundles;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.core.DefaultKafkaProducerFactory;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.listener.DeadLetterPublishingRecoverer;
import org.springframework.kafka.listener.DefaultErrorHandler;
import org.springframework.kafka.support.serializer.DelegatingByTypeSerializer;
import org.springframework.kafka.support.serializer.JsonSerializer;
import org.springframework.util.backoff.FixedBackOff;

@Configuration
public class KafkaConfig {

    /**
     * Records that can't be deserialised or booked go to {@code payments.settled.DLT}
     * after two quick retries, so a bad event never blocks the partition.
     */
    @Bean
    DefaultErrorHandler errorHandler(KafkaTemplate<Object, Object> deadLetterTemplate) {
        return new DefaultErrorHandler(
                new DeadLetterPublishingRecoverer(deadLetterTemplate), new FixedBackOff(200L, 2L));
    }

    @Bean
    @SuppressWarnings({"rawtypes", "unchecked"})
    KafkaTemplate<Object, Object> deadLetterTemplate(KafkaProperties properties, SslBundles sslBundles) {
        // Raw bytes when deserialisation failed, JSON when booking failed.
        Map<Class<?>, Serializer<?>> values = new LinkedHashMap<>();
        values.put(byte[].class, new ByteArraySerializer());
        values.put(Object.class, new JsonSerializer<>());
        return new KafkaTemplate<>(new DefaultKafkaProducerFactory<Object, Object>(
                properties.buildProducerProperties(sslBundles),
                (Serializer) new StringSerializer(),
                new DelegatingByTypeSerializer(values, true)));
    }

    @Bean
    Clock clock() {
        return Clock.systemUTC();
    }
}
