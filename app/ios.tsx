import React, { useRef, useEffect, useState, useCallback } from 'react';
import { SafeAreaView, StyleSheet, StatusBar, View, BackHandler, Alert, Text, TouchableOpacity, Image, Animated, Platform } from 'react-native';
import { WebView, WebViewNavigation } from 'react-native-webview';
import * as ScreenCapture from 'expo-screen-capture';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import * as FileSystem from 'expo-file-system';
import * as SplashScreen from 'expo-splash-screen';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';

const WEBSITE_URL = 'https://www.flavrapogi.org/';
const CACHE_DIR = FileSystem.cacheDirectory + 'websiteCache/';
const APP_ICON = require('../assets/images/icon.png');

const App: React.FC = () => {
  const webViewRef = useRef<WebView>(null);
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [hasCache, setHasCache] = useState<boolean>(false);
  const [appIsReady, setAppIsReady] = useState<boolean>(false);
  const [currentUrl, setCurrentUrl] = useState<string>(WEBSITE_URL);
  const [isWebViewLoading, setIsWebViewLoading] = useState<boolean>(true);
  const [showOfflineUI, setShowOfflineUI] = useState<boolean>(false);
  const lastOnlineCheckRef = useRef<number>(0);
  const isMountedRef = useRef<boolean>(false);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  // iOS-specific status bar height
  const STATUS_BAR_HEIGHT = Platform.OS === 'ios' ? 44 : StatusBar.currentHeight || 0;

  // Skeleton animation with iOS-style loading
  useEffect(() => {
    if (isWebViewLoading) {
      const pulseAnimation = Animated.loop(
        Animated.sequence([
          Animated.timing(fadeAnim, {
            toValue: 0.5,
            duration: 800,
            useNativeDriver: true,
          }),
          Animated.timing(fadeAnim, {
            toValue: 1,
            duration: 800,
            useNativeDriver: true,
          }),
        ])
      );
      pulseAnimation.start();
      return () => pulseAnimation.stop();
    }
  }, [isWebViewLoading, fadeAnim]);

  // Normalize URL for cache key
  const normalizeUrl = useCallback((url: string): string => {
    try {
      const urlObj = new URL(url);
      urlObj.hash = '';
      urlObj.search = '';
      return urlObj.toString().toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  }, []);

  // Get cache path for a URL
  const getCachePath = useCallback((url: string): string => {
    const normalized = normalizeUrl(url);
    const filename = normalized
      .replace(/^https?:\/\//, '')
      .replace(/[^a-z0-9]/gi, '_')
      .toLowerCase() + '.html';
    return CACHE_DIR + filename;
  }, [normalizeUrl]);

  // Cache a single page with iOS-specific handling
  const cachePage = useCallback(async (url: string): Promise<void> => {
    try {
      const cachePath = getCachePath(url);
      const dirInfo = await FileSystem.getInfoAsync(CACHE_DIR);
      
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
      }

      // iOS-specific caching approach
      const downloadResumable = FileSystem.createDownloadResumable(
        url,
        cachePath,
        { 
          headers: { 
            'Cache-Control': 'max-age=3600',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
          },
          cache: true 
        }
      );

      await downloadResumable.downloadAsync();
      console.log('Cached page:', url);
    } catch (error) {
      console.error('Failed to cache page:', url, error);
    }
  }, [getCachePath]);

  // Check for existing cache
  const checkCache = useCallback(async (url?: string): Promise<boolean> => {
    try {
      const dirInfo = await FileSystem.getInfoAsync(CACHE_DIR);
      if (!dirInfo.exists) {
        return false;
      }
      
      if (url) {
        // Check specific URL cache
        const cachePath = getCachePath(url);
        const fileInfo = await FileSystem.getInfoAsync(cachePath);
        return fileInfo.exists;
      } else {
        // Check any cache exists
        const files = await FileSystem.readDirectoryAsync(CACHE_DIR);
        return files.some(f => f.endsWith('.html'));
      }
    } catch (error) {
      console.error('Cache check failed:', error);
      return false;
    }
  }, [getCachePath]);

  // Load cached content with iOS-specific handling
  const loadCachedContent = useCallback(async (url: string): Promise<boolean> => {
    try {
      const cacheExists = await checkCache(url);
      if (!cacheExists) return false;
      
      const cachePath = getCachePath(url);
      const content = await FileSystem.readAsStringAsync(cachePath);
      
      if (webViewRef.current) {
        webViewRef.current.injectJavaScript(`
          document.open();
          document.write(\`${content.replace(/`/g, '\\`')}\`);
          document.close();
          true;
        `);
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to load cached content:', error);
      return false;
    }
  }, [checkCache, getCachePath]);

  // Handle back button press (less relevant for iOS but kept for Android)
  const handleBackButton = useCallback((): boolean => {
    if (webViewRef.current) {
      webViewRef.current.goBack();
      return true;
    }
    return false;
  }, []);

  // Handle network status changes
  const handleNetworkChange = useCallback((state: NetInfoState): void => {
    if (!isMountedRef.current) return;

    const nowOnline = state.isConnected ?? false;
    setIsOnline(nowOnline);

    if (nowOnline) {
      const now = Date.now();
      if (now - lastOnlineCheckRef.current > 300000) { // 5 minutes
        webViewRef.current?.reload();
      }
      lastOnlineCheckRef.current = now;
      setShowOfflineUI(false);
    } else {
      checkCache(currentUrl).then(cacheExists => {
        if (isMountedRef.current) {
          setHasCache(cacheExists);
          setShowOfflineUI(!nowOnline && cacheExists);
        }
      });
    }
  }, [checkCache, currentUrl]);

  // Handle page navigation
  const handleNavigationStateChange = useCallback(async (navState: WebViewNavigation) => {
    if (!isMountedRef.current) return;

    setCurrentUrl(navState.url);
    setIsWebViewLoading(navState.loading);
    
    if (isOnline) {
      await cachePage(navState.url);
    } else {
      // When offline, verify we have this specific page cached
      const hasThisPageCache = await checkCache(navState.url);
      setHasCache(hasThisPageCache);
      setShowOfflineUI(!isOnline && hasThisPageCache);
    }
  }, [isOnline, cachePage, checkCache]);

  // Refresh the current page
  const handleRefresh = useCallback(async () => {
    if (isOnline) {
      webViewRef.current?.reload();
      setShowOfflineUI(false);
    } else {
      // When offline, try to load from cache again
      const loaded = await loadCachedContent(currentUrl);
      if (!loaded) {
        Alert.alert('Offline', 'No cached version available for this page');
      }
    }
  }, [isOnline, currentUrl, loadCachedContent]);

  // Inject custom HTML for iOS-specific UI enhancements
  const injectIOSSupport = useCallback(() => {
    if (!webViewRef.current) return;
    
    const script = `
      (function() {
        // Add iOS-specific viewport meta tag if not present
        if (!document.querySelector('meta[name="viewport"][content*="viewport-fit=cover"]')) {
          const meta = document.createElement('meta');
          meta.name = 'viewport';
          meta.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover';
          document.head.appendChild(meta);
        }
        
        // Add safe area insets for iOS notch devices
        document.documentElement.style.setProperty('--safe-area-inset-top', 'env(safe-area-inset-top, 0px)');
        document.documentElement.style.setProperty('--safe-area-inset-bottom', 'env(safe-area-inset-bottom, 0px)');
        document.documentElement.style.setProperty('--safe-area-inset-left', 'env(safe-area-inset-left, 0px)');
        document.documentElement.style.setProperty('--safe-area-inset-right', 'env(safe-area-inset-right, 0px)');
        
        // Style adjustments for iOS
        document.body.style.webkitTouchCallout = 'none';
        document.body.style.webkitUserSelect = 'none';
        document.body.style.overscrollBehavior = 'none';
        
        // Add status bar background for iOS
        if (!document.getElementById('status-bar-bg')) {
          const statusBar = document.createElement('div');
          statusBar.id = 'status-bar-bg';
          statusBar.style.position = 'fixed';
          statusBar.style.top = '0';
          statusBar.style.left = '0';
          statusBar.style.right = '0';
          statusBar.style.height = 'var(--safe-area-inset-top, 0px)';
          statusBar.style.backgroundColor = '#FF8400';
          statusBar.style.zIndex = '99999';
          document.body.appendChild(statusBar);
        }
        
        // Prevent elastic bounce effect on iOS
        document.body.style.overflow = 'hidden';
        document.documentElement.style.overflow = 'hidden';
      })();
    `;
    
    webViewRef.current.injectJavaScript(script);
  }, []);

  // Prepare the app
  useEffect(() => {
    isMountedRef.current = true;
    let unsubscribeNetInfo: () => void;

    const prepareApp = async (): Promise<void> => {
      try {
        await SplashScreen.preventAutoHideAsync();
        
        // First check if we have any cache at all
        const initialCacheCheck = await checkCache();
        setHasCache(initialCacheCheck);
        
        // Then check network status
        const netState = await NetInfo.fetch();
        const nowOnline = netState.isConnected ?? false;
        setIsOnline(nowOnline);
        
        if (isMountedRef.current) {
          setShowOfflineUI(!nowOnline && initialCacheCheck);
          lastOnlineCheckRef.current = Date.now();
          
          if (nowOnline) {
            // Cache the homepage if online
            await cachePage(WEBSITE_URL);
          } else if (initialCacheCheck) {
            // If offline but have cache, load it immediately
            await loadCachedContent(WEBSITE_URL);
            setIsWebViewLoading(false);
          }
        }
      } catch (error) {
        console.error('App initialization failed:', error);
      } finally {
        if (isMountedRef.current) {
          setAppIsReady(true);
          await SplashScreen.hideAsync();
        }
      }
    };

    prepareApp();
    unsubscribeNetInfo = NetInfo.addEventListener(handleNetworkChange);
    
    // Only prevent screenshots if not in development
    if (!__DEV__) {
      ScreenCapture.preventScreenCaptureAsync();
    }
    
    // Add back button handler only for Android
    if (Platform.OS === 'android') {
      BackHandler.addEventListener('hardwareBackPress', handleBackButton);
    }

    return () => {
      isMountedRef.current = false;
      unsubscribeNetInfo?.();
      if (Platform.OS === 'android') {
        BackHandler.removeEventListener('hardwareBackPress', handleBackButton);
      }
      if (!__DEV__) {
        ScreenCapture.allowScreenCaptureAsync();
      }
    };
  }, [checkCache, handleNetworkChange, handleBackButton, cachePage, loadCachedContent]);

  const renderLoading = () => (
    <View style={styles.loadingContainer}>
      {/* iOS-style header skeleton */}
      <Animated.View style={[styles.skeletonHeader, { 
        height: STATUS_BAR_HEIGHT + 44, // Status bar + navigation bar height
        opacity: fadeAnim 
      }]} />
      
      {/* iOS-style content skeleton */}
      <View style={styles.skeletonContent}>
        <Animated.View style={[styles.skeletonLine, { 
          width: '90%', 
          opacity: fadeAnim,
          borderRadius: 4,
          backgroundColor: '#f0f0f0'
        }]} />
        <Animated.View style={[styles.skeletonLine, { 
          width: '80%', 
          opacity: fadeAnim,
          borderRadius: 4,
          backgroundColor: '#f0f0f0'
        }]} />
        <Animated.View style={[styles.skeletonLine, { 
          width: '85%', 
          opacity: fadeAnim,
          borderRadius: 4,
          backgroundColor: '#f0f0f0'
        }]} />
        <Animated.View style={[styles.skeletonLine, { 
          width: '70%', 
          opacity: fadeAnim,
          borderRadius: 4,
          backgroundColor: '#f0f0f0'
        }]} />
        
        {/* Image Placeholder with iOS-style rounded corners */}
        <Animated.View style={[styles.skeletonImage, { 
          opacity: fadeAnim,
          borderRadius: 8,
          backgroundColor: '#f0f0f0'
        }]} />
        
        {/* More Content */}
        <Animated.View style={[styles.skeletonLine, { 
          width: '90%', 
          opacity: fadeAnim,
          borderRadius: 4,
          backgroundColor: '#f0f0f0'
        }]} />
        <Animated.View style={[styles.skeletonLine, { 
          width: '75%', 
          opacity: fadeAnim,
          borderRadius: 4,
          backgroundColor: '#f0f0f0'
        }]} />
        <Animated.View style={[styles.skeletonLine, { 
          width: '85%', 
          opacity: fadeAnim,
          borderRadius: 4,
          backgroundColor: '#f0f0f0'
        }]} />
      </View>
    </View>
  );

  if (!appIsReady) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaView style={[styles.container, Platform.OS === 'ios' ? styles.iosSafeArea : {}]}>
        <StatusBar barStyle="light-content" backgroundColor="#000000" />
        
        <WebView
          ref={webViewRef}
          source={{ 
            uri: isOnline ? currentUrl : (hasCache ? `file://${getCachePath(currentUrl)}` : WEBSITE_URL)
          }}
          style={styles.webview}
          startInLoadingState={true}
          renderLoading={renderLoading}
          onNavigationStateChange={handleNavigationStateChange}
          onLoadEnd={() => {
            setIsWebViewLoading(false);
            injectIOSSupport();
          }}
          domStorageEnabled={true}
          javaScriptEnabled={true}
          cacheEnabled={true}
          applicationNameForUserAgent="FlavraPogiApp/1.0 iOS"
          allowsInlineMediaPlayback={true}
          allowsBackForwardNavigationGestures={true}
          decelerationRate="normal"
          bounces={false}
          scrollEnabled={true}
          sharedCookiesEnabled={true}
          onError={(syntheticEvent) => {
            console.error('WebView error:', syntheticEvent.nativeEvent);
            if (!isOnline && hasCache) {
              loadCachedContent(currentUrl);
            }
          }}
          injectedJavaScriptBeforeContentLoaded={`
            // iOS-specific viewport setup before content loads
            if (!document.querySelector('meta[name="viewport"]')) {
              const meta = document.createElement('meta');
              meta.name = 'viewport';
              meta.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover';
              document.head.appendChild(meta);
            }
            true;
          `}
          injectedJavaScript={`
            // iOS-specific DOM enhancements
            document.documentElement.style.scrollBehavior = 'smooth';
            document.body.style.overscrollBehaviorY = 'none';
            document.body.style.webkitOverflowScrolling = 'touch';
            
            // Add safe area insets for iOS
            document.documentElement.style.setProperty('--safe-area-inset-top', 'env(safe-area-inset-top, 0px)');
            document.documentElement.style.setProperty('--safe-area-inset-bottom', 'env(safe-area-inset-bottom, 0px)');
            
            true;
          `}
        />
        
        {!isOnline && !hasCache && (
          <View style={styles.fullScreenOverlay}>
            <View style={styles.offlineContentContainer}>
              <Image source={APP_ICON} style={styles.offlineIconLarge} />
              <Text style={styles.offlineTitleLarge}>No Internet Connection</Text>
              <Text style={styles.offlineMessageLarge}>Please connect to the internet to access content</Text>
              
              <View style={styles.buttonContainer}>
                <TouchableOpacity 
                  onPress={handleRefresh} 
                  style={[styles.refreshButtonLarge, Platform.OS === 'ios' ? styles.iosButton : {}]}
                  activeOpacity={0.7}
                >
                  <Ionicons name="refresh" size={24} color="#FF8400" />
                  <Text style={styles.refreshButtonText}>Retry Connection</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}

        {showOfflineUI && (
          <View style={[styles.offlineIndicator, Platform.OS === 'ios' ? styles.iosOfflineIndicator : {}]}>
            <View style={styles.offlineIndicatorContent}>
              <Ionicons name="cloud-offline" size={16} color="white" />
              <Text style={styles.offlineIndicatorText}>Offline Mode</Text>
            </View>
            <TouchableOpacity 
              onPress={handleRefresh} 
              style={styles.refreshButtonSmall}
              activeOpacity={0.7}
            >
              <Ionicons name="refresh" size={16} color="white" />
            </TouchableOpacity>
          </View>
        )}
      </SafeAreaView>
    </GestureHandlerRootView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
  iosSafeArea: {
    paddingTop: 0, // Let iOS handle the safe area
  },
  webview: {
    flex: 1,
    marginTop: Platform.OS === 'ios' ? 0 : StatusBar.currentHeight || 0,
  },
  loadingContainer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#ffffff',
    paddingTop: Platform.OS === 'ios' ? 44 : StatusBar.currentHeight || 0,
  },
  skeletonHeader: {
    backgroundColor: '#f0f0f0',
    marginBottom: 16,
  },
  skeletonContent: {
    paddingHorizontal: 16,
  },
  skeletonLine: {
    height: 16,
    marginBottom: 12,
  },
  skeletonImage: {
    height: 200,
    marginVertical: 16,
  },
  fullScreenOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(255, 255, 255, 0.95)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1000,
  },
  offlineContentContainer: {
    width: '80%',
    maxWidth: 400,
    alignItems: 'center',
    padding: 20,
  },
  offlineIconLarge: {
    width: 80,
    height: 80,
    marginBottom: 20,
    tintColor: '#FF8400',
  },
  offlineTitleLarge: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 8,
    textAlign: 'center',
  },
  offlineMessageLarge: {
    fontSize: 16,
    color: '#666',
    textAlign: 'center',
    marginBottom: 30,
  },
  buttonContainer: {
    width: '100%',
    alignItems: 'center',
  },
  refreshButtonLarge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'white',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 25,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#FF8400',
  },
  iosButton: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  refreshButtonText: {
    color: '#FF8400',
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 8,
  },
  offlineIndicator: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 44 : 10,
    right: 10,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    borderRadius: 15,
    paddingVertical: 6,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 1000,
  },
  iosOfflineIndicator: {
    top: 54, // Below the status bar on iOS
  },
  offlineIndicatorContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  offlineIndicatorText: {
    color: 'white',
    fontSize: 12,
    marginLeft: 5,
  },
  refreshButtonSmall: {
    marginLeft: 8,
  },
});

export default React.memo(App);