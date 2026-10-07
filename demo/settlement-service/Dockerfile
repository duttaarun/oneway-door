# syntax=docker/dockerfile:1
FROM eclipse-temurin:21-jdk AS build
WORKDIR /src
COPY .mvn .mvn
COPY mvnw pom.xml ./
COPY src src
ARG SKIP_TESTS=true
RUN --mount=type=cache,target=/root/.m2 ./mvnw -B -q package -DskipTests=${SKIP_TESTS}

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /src/target/app.jar app.jar
EXPOSE 8081
ENTRYPOINT ["java", "-XX:+UseSerialGC", "-Xss512k", "-XX:TieredStopAtLevel=1", "-jar", "/app/app.jar"]
