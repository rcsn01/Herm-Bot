import Capacitor
import Foundation
import UIKit
import WebKit

private enum HermesConnectionError: LocalizedError {
    case invalidResponse
    case message(String)
    case unauthorized(String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse: return "The remote Hermes response was invalid."
        case .message(let message): return message
        case .unauthorized(let message): return message
        }
    }
}

@objc(HermesConnectionPlugin)
public final class HermesConnectionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HermesConnectionPlugin"
    public let jsName = "HermesConnection"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "probe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "upload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAuthMode", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getWebSocketURL", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "login", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "passwordLogin", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "logout", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearConnection", returnType: CAPPluginReturnPromise)
    ]

    private let defaults = UserDefaults.standard
    private let keychain = HermesKeychain()
    private var authMode = "token"
    private var loginController: HermesLoginViewController?
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.httpCookieAcceptPolicy = .always
        configuration.httpCookieStorage = HTTPCookieStorage.shared
        configuration.httpShouldSetCookies = true
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 30
        return URLSession(configuration: configuration)
    }()

    @objc public func configure(_ call: CAPPluginCall) {
        do {
            let remoteURL = try validatedRemoteURL(call.getString("remoteURL") ?? "")
            let previousURL = storedRemoteURL()
            let saveConfiguration = {
                self.defaults.set(remoteURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forKey: "remoteURL")
                do {
                    if let token = call.getString("token")?.trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty {
                        try self.keychain.saveToken(token)
                    } else {
                        self.keychain.deleteToken()
                    }
                    call.resolve(["remoteURL": self.storedRemoteURL()?.absoluteString ?? remoteURL.absoluteString])
                } catch {
                    call.reject(error.localizedDescription)
                }
            }
            if let previousURL, previousURL != remoteURL {
                keychain.deleteToken()
                clearCookies(for: previousURL, completion: saveConfiguration)
            } else { saveConfiguration() }
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc public func probe(_ call: CAPPluginCall) {
        perform(path: "/api/status") { result in
            switch result {
            case .success((_, let body, _)):
                guard let status = body as? JSObject else { return call.reject("Invalid status response.") }
                self.authMode = (status["auth_required"] as? Bool) == true && self.keychain.readToken() == nil
                    ? "interactive"
                    : "token"
                call.resolve(["authMode": self.authMode, "status": status])
            case .failure(let error): call.reject(error.localizedDescription)
            }
        }
    }

    @objc public func getAuthMode(_ call: CAPPluginCall) {
        call.resolve(["authMode": authMode])
    }

    @objc public func request(_ call: CAPPluginCall) {
        let path = call.getString("path") ?? ""
        guard isAllowedPath(path) else { return call.reject("Only Hermes API and auth paths are allowed.") }
        let method = call.getString("method") ?? "GET"
        let timeout = (call.getDouble("timeoutMs") ?? 30_000) / 1_000
        perform(path: path, method: method, json: call.options["body"], timeout: timeout) { result in
            self.resolve(call, result: result)
        }
    }

    @objc public func upload(_ call: CAPPluginCall) {
        let path = call.getString("path") ?? ""
        guard isAllowedPath(path) else { return call.reject("Only Hermes API paths are allowed.") }
        guard let base64 = call.getString("dataBase64"), let data = Data(base64Encoded: base64) else {
            return call.reject("Invalid upload data.")
        }
        let boundary = "HermesMobile-\(UUID().uuidString)"
        let field = call.getString("field") ?? "file"
        let filename = sanitizedFilename(call.getString("filename") ?? "upload")
        let contentType = call.getString("contentType") ?? "application/octet-stream"
        var body = Data()
        body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(field)\"; filename=\"\(filename)\"\r\nContent-Type: \(contentType)\r\n\r\n".data(using: .utf8)!)
        body.append(data)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        perform(path: path, method: "POST", rawBody: body, contentType: "multipart/form-data; boundary=\(boundary)") { result in
            self.resolve(call, result: result)
        }
    }

    @objc public func getWebSocketURL(_ call: CAPPluginCall) {
        let profile = call.getString("profile")
        if authMode == "interactive" {
            perform(path: "/api/auth/ws-ticket", method: "POST") { result in
                switch result {
                case .success((_, let body, _)):
                    guard let ticket = (body as? JSObject)?["ticket"] as? String else {
                        return call.reject("Could not mint a WebSocket ticket.")
                    }
                    self.resolveWebSocket(call, authName: "ticket", authValue: ticket, profile: profile)
                case .failure(let error): self.reject(call, error: error)
                }
            }
        } else {
            guard let token = keychain.readToken(), !token.isEmpty else {
                return call.reject("A gateway token is required for this remote Hermes.")
            }
            resolveWebSocket(call, authName: "token", authValue: token, profile: profile)
        }
    }

    @objc public func login(_ call: CAPPluginCall) {
        guard let provider = call.getString("provider"), !provider.isEmpty else {
            return call.reject("Choose an authentication provider.")
        }
        guard let gateway = storedRemoteURL() else {
            return call.reject("Configure a valid gateway first.")
        }
        DispatchQueue.main.async {
            guard self.loginController == nil else { return call.reject("A sign-in is already open.") }
            let controller = HermesLoginViewController(
                gateway: gateway,
                provider: provider,
                session: self.session
            ) { result in
                self.bridge?.viewController?.dismiss(animated: true)
                self.loginController = nil
                switch result {
                case .success(let identity):
                    self.authMode = "interactive"
                    call.resolve(identity)
                case .failure(let error): call.reject(error.localizedDescription)
                }
            }
            self.loginController = controller
            let navigation = UINavigationController(rootViewController: controller)
            navigation.modalPresentationStyle = .formSheet
            guard let presenter = self.bridge?.viewController else {
                self.loginController = nil
                return call.reject("Could not present the Hermes sign-in sheet.")
            }
            presenter.present(navigation, animated: true)
        }
    }

    @objc public func passwordLogin(_ call: CAPPluginCall) {
        let body: JSObject = [
            "provider": call.getString("provider") ?? "",
            "username": call.getString("username") ?? "",
            "password": call.getString("password") ?? ""
        ]
        perform(path: "/auth/password-login", method: "POST", json: body) { result in
            switch result {
            case .failure(let error): call.reject(error.localizedDescription)
            case .success:
                self.authMode = "interactive"
                self.perform(path: "/api/auth/me") { identityResult in
                    switch identityResult {
                    case .success((_, let identity, _)): call.resolve(identity as? JSObject ?? [:])
                    case .failure(let error): call.reject(error.localizedDescription)
                    }
                }
            }
        }
    }

    @objc public func logout(_ call: CAPPluginCall) {
        perform(path: "/auth/logout", method: "POST") { _ in
            guard let gateway = self.storedRemoteURL() else { return call.resolve() }
            self.clearCookies(for: gateway) { call.resolve() }
        }
    }

    @objc public func clearConnection(_ call: CAPPluginCall) {
        keychain.deleteToken()
        guard let gateway = storedRemoteURL() else {
            defaults.removeObject(forKey: "remoteURL")
            return call.resolve()
        }
        clearCookies(for: gateway) {
            self.defaults.removeObject(forKey: "remoteURL")
            call.resolve()
        }
    }

    /// JSONSerialization yields Foundation types (NSString, NSDictionary) that do NOT
    /// satisfy Capacitor's JSValue conformance, so ``as? JSObject`` fails on any real
    /// payload. Normalize the tree so every node is a JSValue-conforming Swift type.
    private func jsValue(_ value: Any) -> JSValue {
        switch value {
        case let dict as [String: Any]:
            return dict.mapValues(jsValue)
        case let array as [Any]:
            return array.map(jsValue)
        case let string as String:
            return string
        case let null as NSNull:
            return null
        case let number as NSNumber: // JSON booleans included; NSNumber bridges to Bool for as? Bool reads
            return number
        default:
            return String(describing: value)
        }
    }

    private func perform(
        path: String,
        method: String = "GET",
        json: Any? = nil,
        rawBody: Data? = nil,
        contentType: String? = nil,
        timeout: TimeInterval = 30,
        completion: @escaping (Result<(HTTPURLResponse, Any, [String: String]), Error>) -> Void
    ) {
        guard let url = gatewayURL(path: path) else {
            return completion(.failure(HermesConnectionError.message("Configure a valid gateway first.")))
        }
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = method.uppercased()
        request.httpShouldHandleCookies = true
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if authMode == "token", let token = keychain.readToken() {
            request.setValue(token, forHTTPHeaderField: "X-Hermes-Session-Token")
        }
        do {
            if let rawBody {
                request.httpBody = rawBody
                request.setValue(contentType, forHTTPHeaderField: "Content-Type")
            } else if let json {
                request.httpBody = try JSONSerialization.data(withJSONObject: json)
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            }
        } catch { return completion(.failure(error)) }

        session.dataTask(with: request) { data, response, error in
            if let error { return completion(.failure(error)) }
            guard let http = response as? HTTPURLResponse else {
                return completion(.failure(HermesConnectionError.invalidResponse))
            }
            let parsed: Any
            if let data, !data.isEmpty {
                if let raw = try? JSONSerialization.jsonObject(with: data) {
                    parsed = self.jsValue(raw)
                } else {
                    parsed = ["raw": String(data: data, encoding: .utf8) ?? ""]
                }
            } else { parsed = [:] }
            if !(200..<300).contains(http.statusCode) {
                let detail = (parsed as? JSObject)?["detail"] as? String
                    ?? (parsed as? JSObject)?["error"] as? String
                    ?? "Hermes returned HTTP \(http.statusCode)."
                let failure: HermesConnectionError = http.statusCode == 401
                    ? .unauthorized(detail)
                    : .message(detail)
                return completion(.failure(failure))
            }
            var headers: [String: String] = [:]
            http.allHeaderFields.forEach { headers[String(describing: $0.key)] = String(describing: $0.value) }
            completion(.success((http, parsed, headers)))
        }.resume()
    }

    private func resolve(_ call: CAPPluginCall, result: Result<(HTTPURLResponse, Any, [String: String]), Error>) {
        switch result {
        case .failure(let error): reject(call, error: error)
        case .success((let response, let body, let headers)):
            call.resolve(["status": response.statusCode, "body": body, "headers": headers])
        }
    }

    private func reject(_ call: CAPPluginCall, error: Error) {
        if case HermesConnectionError.unauthorized = error {
            call.reject(error.localizedDescription, "AUTH_REQUIRED")
        } else {
            call.reject(error.localizedDescription)
        }
    }

    private func resolveWebSocket(_ call: CAPPluginCall, authName: String, authValue: String, profile: String?) {
        guard let httpURL = gatewayURL(path: "/api/ws"),
              var components = URLComponents(url: httpURL, resolvingAgainstBaseURL: false) else {
            return call.reject("Could not construct the gateway WebSocket URL.")
        }
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.queryItems = [URLQueryItem(name: authName, value: authValue)]
        if let profile, !profile.isEmpty { components.queryItems?.append(URLQueryItem(name: "profile", value: profile)) }
        guard let url = components.url else { return call.reject("Could not construct the gateway WebSocket URL.") }
        call.resolve(["url": url.absoluteString])
    }

    private func storedRemoteURL() -> URL? {
        guard let raw = defaults.string(forKey: "remoteURL") else { return nil }
        return URL(string: raw)
    }

    private func gatewayURL(path: String) -> URL? {
        guard let base = storedRemoteURL() else { return nil }
        let basePath = base.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if !basePath.isEmpty && path.hasPrefix("/\(basePath)/") {
            var origin = URLComponents(url: base, resolvingAgainstBaseURL: false)
            let relative = URLComponents(string: path)
            origin?.path = relative?.path ?? path
            origin?.queryItems = relative?.queryItems
            origin?.fragment = nil
            return origin?.url
        }
        return URL(string: base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + (path.hasPrefix("/") ? path : "/\(path)"))
    }

    private func validatedRemoteURL(_ raw: String) throws -> URL {
        #if targetEnvironment(simulator)
        return try HermesRemoteURLValidator.validate(raw, allowLocalHTTP: true)
        #else
        return try HermesRemoteURLValidator.validate(raw, allowLocalHTTP: false)
        #endif
    }

    private func isAllowedPath(_ path: String) -> Bool {
        path.hasPrefix("/api/") || path.hasPrefix("/auth/")
    }

    private func clearCookies(for gateway: URL, completion: @escaping () -> Void) {
        let nativeCookies = HermesSessionCookiePolicy.cookies(HTTPCookieStorage.shared.cookies ?? [], for: gateway)
        nativeCookies.forEach { HTTPCookieStorage.shared.deleteCookie($0) }

        let webCookieStore = WKWebsiteDataStore.default().httpCookieStore
        webCookieStore.getAllCookies { cookies in
            let gatewayCookies = HermesSessionCookiePolicy.cookies(cookies, for: gateway)
            guard !gatewayCookies.isEmpty else { return DispatchQueue.main.async(execute: completion) }
            let group = DispatchGroup()
            gatewayCookies.forEach { cookie in
                group.enter()
                webCookieStore.delete(cookie) { group.leave() }
            }
            group.notify(queue: .main, execute: completion)
        }
    }

    private func sanitizedFilename(_ filename: String) -> String {
        filename.replacingOccurrences(of: "[\\r\\n\\\"]", with: "_", options: .regularExpression)
    }
}
