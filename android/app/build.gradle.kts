plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.gms.google-services")
}

// The build number on GitHub (android.yml); 1 on a computer. The app compares it to find updates.
val build = (System.getenv("VERSION_CODE") ?: "1").toInt()

android {
    namespace = "com.iklipse.app"
    compileSdk = 35

    defaultConfig {
        // The Android app in the Firebase project (google-services.json) has this id.
        applicationId = "com.abdelrahman12_3.mobile"
        minSdk = 26
        targetSdk = 35
        versionCode = build
        versionName = "1.0.$build"
        buildConfigField("String", "API", "\"https://larhrofldblegktowhdw.supabase.co/functions/v1/whatsapp-bot\"")
        buildConfigField("String", "APP_URL", "\"https://abdelrahman843.github.io/iklipse-global-system/\"")
    }

    signingConfigs {
        create("release") {
            System.getenv("KEYSTORE_FILE")?.let {
                storeFile = file(it)
                storeType = "pkcs12"
                storePassword = System.getenv("KEYSTORE_PASSWORD")
                keyAlias = "iklipse"
                keyPassword = System.getenv("KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation(platform("com.google.firebase:firebase-bom:33.7.0"))
    implementation("com.google.firebase:firebase-messaging")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.webkit:webkit:1.11.0")
    // Sign-ins (Calendly, Google) in the app's own browser tab, closed on the way back.
    implementation("androidx.browser:browser:1.8.0")
}
