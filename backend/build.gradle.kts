plugins {
    kotlin("jvm") version "2.4.21"
    kotlin("plugin.serialization") version "2.4.21"
    application
}

repositories { mavenCentral() }

dependencies { implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0") }

application { mainClass = "MainKt" }

// The frontend lives next to the backend, the binary embeds it as classpath resources.
tasks.processResources { from("../frontend") { into("frontend") } }
