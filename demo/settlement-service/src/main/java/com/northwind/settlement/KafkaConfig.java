package com.northwind.settlement;

import java.time.Clock;

import org.apache.kafka.common.serialization.StringSerializer;
import org.springframework.boot.autoconfigure.kafka.KafkaProperties;
import org.springframework.boot.ssl.SslBundles;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.kafka.core.DefaultKafkaProducerFactory;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.core.ProducerFactory;
import org.springframework.kafka.support.serializer.JsonSerializer;

import com.fasterxml.jackson.databind.ObjectMapper;

@Configuration
public class KafkaConfig {

    @Bean
    ProducerFactory<String, PaymentSettled> paymentSettledProducerFactory(KafkaProperties properties,
                                                                         SslBundles sslBundles,
                                                                         ObjectMapper objectMapper) {
        JsonSerializer<PaymentSettled> json = new JsonSerializer<>(objectMapper);
        // No __TypeId__ header: consumers bind the payload by field name to their own class.
        json.setAddTypeInfo(false);
        return new DefaultKafkaProducerFactory<>(
                properties.buildProducerProperties(sslBundles), new StringSerializer(), json);
    }

    @Bean
    KafkaTemplate<String, PaymentSettled> paymentSettledTemplate(ProducerFactory<String, PaymentSettled> factory) {
        return new KafkaTemplate<>(factory);
    }

    @Bean
    Clock clock() {
        return Clock.systemUTC();
    }
}
