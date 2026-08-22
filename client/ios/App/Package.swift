// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "HermesNativeSecurity",
    defaultLocalization: "en",
    platforms: [.macOS(.v13)],
    products: [.library(name: "HermesNativeSecurity", targets: ["HermesNativeSecurity"])],
    targets: [
        .target(
            name: "HermesNativeSecurity",
            path: "App",
            exclude: [
                "AppDelegate.swift", "HermesBridgeViewController.swift",
                "HermesConnectionPlugin.swift", "HermesLoginViewController.swift",
                "Assets.xcassets", "Base.lproj",
                "Info.plist", "public", "capacitor.config.json", "config.xml"
            ],
            sources: ["HermesNativeSecurity.swift"]
        ),
        .testTarget(
            name: "HermesNativeSecurityTests",
            dependencies: ["HermesNativeSecurity"],
            path: "AppTests"
        )
    ]
)
