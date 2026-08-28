import Capacitor

final class HermesBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(HermesConnectionPlugin())
        webView?.scrollView.pinchGestureRecognizer?.isEnabled = false
    }
}
