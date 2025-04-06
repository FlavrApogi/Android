import React, { useRef, useEffect, useState, useCallback } from 'react';
import { SafeAreaView, StyleSheet, StatusBar, View, BackHandler, Alert, Text, TouchableOpacity, Image, Animated } from 'react-native';
import { WebView, WebViewNavigation } from 'react-native-webview';
import * as ScreenCapture from 'expo-screen-capture';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import * as FileSystem from 'expo-file-system';
import * as SplashScreen from 'expo-splash-screen';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Ionicons } from '@expo/vector-icons';

const Favicon = require('../assets/images/favicon.png');
const WEBSITE_URL = 'https://www.flavrapogi.org/';
const CACHE_DIR = FileSystem.documentDirectory + 'websiteCache/';
const APP_ICON = require('../assets/images/icon.png');
const LAST_UPDATE_KEY = '@FlavraPogi:lastUpdate';
const CACHE_EXPIRY_DAYS = 7;

const App: React.FC = () => {
  const webViewRef = useRef<WebView>(null);
  const [isOnline, setIsOnline] = useState<boolean>(true);
  const [hasCache, setHasCache] = useState<boolean>(false);
  const [appIsReady, setAppIsReady] = useState<boolean>(false);
  const [currentUrl, setCurrentUrl] = useState<string>(WEBSITE_URL);
  const [isWebViewLoading, setIsWebViewLoading] = useState<boolean>(true);
  const [showOfflineUI, setShowOfflineUI] = useState<boolean>(false);
  const [lastUpdate, setLastUpdate] = useState<string>('');
  const lastOnlineCheckRef = useRef<number>(0);
  const isMountedRef = useRef<boolean>(false);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  // Wave animation for loading
  useEffect(() => {
    if (isWebViewLoading) {
      fadeAnim.setValue(0);
      const waveAnimation = Animated.loop(
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 1500,
          useNativeDriver: true,
        })
      );
      waveAnimation.start();
      return () => waveAnimation.stop();
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

  // Check if cache is expired
  const isCacheExpired = useCallback(async (): Promise<boolean> => {
    try {
      const lastUpdateStr = await AsyncStorage.getItem(LAST_UPDATE_KEY);
      if (!lastUpdateStr) return true;
      
      const lastUpdateDate = new Date(lastUpdateStr);
      const expiryDate = new Date();
      expiryDate.setDate(expiryDate.getDate() - CACHE_EXPIRY_DAYS);
      
      return lastUpdateDate < expiryDate;
    } catch (error) {
      console.error('Failed to check cache expiry:', error);
      return true;
    }
  }, []);

  // Cache a single page
  const cachePage = useCallback(async (url: string): Promise<void> => {
    try {
      const cachePath = getCachePath(url);
      const dirInfo = await FileSystem.getInfoAsync(CACHE_DIR);
      
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true });
      }

      const downloadResumable = FileSystem.createDownloadResumable(
        url,
        cachePath,
        { 
          headers: { 'Cache-Control': 'max-age=3600' },
          cache: true 
        }
      );

      await downloadResumable.downloadAsync();
      
      // Update last cache timestamp
      const now = new Date().toISOString();
      await AsyncStorage.setItem(LAST_UPDATE_KEY, now);
      setLastUpdate(new Date(now).toLocaleDateString());
      
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

  // Load cached content
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

  // Handle back button press
  const handleBackButton = useCallback((): boolean => {
    if (webViewRef.current) {
      webViewRef.current.goBack();
      return true;
    }
    return false;
  }, []);

  // Handle network status changes
  const handleNetworkChange = useCallback(async (state: NetInfoState): Promise<void> => {
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
      
      // Update last update time when back online
      const lastUpdateStr = await AsyncStorage.getItem(LAST_UPDATE_KEY);
      if (lastUpdateStr) {
        setLastUpdate(new Date(lastUpdateStr).toLocaleDateString());
      }
    } else {
      const cacheExists = await checkCache(currentUrl);
      if (isMountedRef.current) {
        setHasCache(cacheExists);
        setShowOfflineUI(!nowOnline && cacheExists);
      }
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

  // Clear all cached content
  const clearCache = useCallback(async () => {
    try {
      await FileSystem.deleteAsync(CACHE_DIR, { idempotent: true });
      await AsyncStorage.removeItem(LAST_UPDATE_KEY);
      setHasCache(false);
      setLastUpdate('');
      Alert.alert('Cache Cleared', 'All cached content has been removed');
    } catch (error) {
      console.error('Failed to clear cache:', error);
      Alert.alert('Error', 'Failed to clear cache');
    }
  }, []);

  // Inject custom HTML for offline navigation
  const injectOfflineSupport = useCallback(() => {
    if (!webViewRef.current) return;
    
    const script = `
      (function() {
        // Add offline indicator
        if (!document.getElementById('offline-indicator')) {
          const cacheIndicator = document.createElement('div');
          cacheIndicator.style.position = 'fixed';
          cacheIndicator.style.bottom = '10px';
          cacheIndicator.style.right = '10px';
          cacheIndicator.style.backgroundColor = 'rgba(0, 0, 0, 0)';
          cacheIndicator.style.color = 'white';
          cacheIndicator.style.padding = '5px 10px';
          cacheIndicator.style.borderRadius = '5px';
          cacheIndicator.style.zIndex = '-1';
          cacheIndicator.style.fontSize = '12px';
          cacheIndicator.id = 'offline-indicator';
          document.body.appendChild(cacheIndicator);
        }
        
        // Modify the page to look more app-like
        document.documentElement.style.setProperty('--safe-area-inset-top', 'env(safe-area-inset-top)');
        document.documentElement.style.setProperty('--safe-area-inset-bottom', 'env(safe-area-inset-bottom)');
        
        // Add status bar background
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
        
        // Load last update time from storage
        const lastUpdateStr = await AsyncStorage.getItem(LAST_UPDATE_KEY);
        if (lastUpdateStr) {
          setLastUpdate(new Date(lastUpdateStr).toLocaleDateString());
        }
        
        // First check if we have any cache at all
        const initialCacheCheck = await checkCache();
        setHasCache(initialCacheCheck);
        
        // Check if cache is expired
        const cacheExpired = await isCacheExpired();
        
        // Then check network status
        const netState = await NetInfo.fetch();
        const nowOnline = netState.isConnected ?? false;
        setIsOnline(nowOnline);
        
        if (isMountedRef.current) {
          setShowOfflineUI(!nowOnline && initialCacheCheck);
          lastOnlineCheckRef.current = Date.now();
          
          if (nowOnline) {
            // Cache the homepage if online (and if cache is expired or doesn't exist)
            if (cacheExpired || !initialCacheCheck) {
              await cachePage(WEBSITE_URL);
            }
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
    ScreenCapture.preventScreenCaptureAsync();
    BackHandler.addEventListener('hardwareBackPress', handleBackButton);

    return () => {
      isMountedRef.current = false;
      unsubscribeNetInfo?.();
      BackHandler.removeEventListener('hardwareBackPress', handleBackButton);
      ScreenCapture.allowScreenCaptureAsync();
    };
  }, [checkCache, handleNetworkChange, handleBackButton, cachePage, loadCachedContent, isCacheExpired]);

  const renderLoading = () => (
    <View style={styles.loadingContainer}>
      <View style={styles.faviconContainer}>
        <Image 
          source={Favicon} 
          style={styles.favicon} 
        />
        {/* Wave animation elements */}
        {[1, 2, 3, 4].map((i) => (
          <Animated.View
            key={i}
            style={[
              styles.wave,
              {
                transform: [{ scale: fadeAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [1, 1.5 + (i * 0.3)]
                }) }],
                opacity: fadeAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.7 - (i * 0.15), 0]
                })
              }
            ]}
          />
        ))}
      </View>
    </View>
  );

  if (!appIsReady) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaView style={styles.container}>
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
            if (!isOnline) injectOfflineSupport();
          }}
          domStorageEnabled={true}
          javaScriptEnabled={true}
          cacheEnabled={true}
          applicationNameForUserAgent="FlavraPogiApp/1.0"
          onError={(syntheticEvent) => {
            console.error('WebView error:', syntheticEvent.nativeEvent);
            if (!isOnline && hasCache) {
              loadCachedContent(currentUrl);
            }
          }}
          injectedJavaScript={`
            if (!document.querySelector('meta[data-cache-url]')) {
              const meta = document.createElement('meta');
              meta.setAttribute('data-cache-url', window.location.href);
              document.head.appendChild(meta);
            }
            
            document.documentElement.style.scrollBehavior = 'smooth';
            document.body.style.overscrollBehaviorY = 'none';
            
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
                  style={styles.refreshButtonLarge}
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
          <View style={styles.offlineIndicator}>
            <View style={styles.offlineIndicatorContent}>
              <Ionicons name="cloud-offline" size={16} color="white" />
              <Text style={styles.offlineIndicatorText}>Offline Mode</Text>
              {lastUpdate && (
                <Text style={styles.offlineIndicatorDate}>Last updated: {lastUpdate}</Text>
              )}
            </View>
            <TouchableOpacity 
              onPress={handleRefresh} 
              style={styles.refreshButtonSmall}
              activeOpacity={0.7}
            >
              <Ionicons name="refresh" size={16} color="white" />
            </TouchableOpacity>
            <TouchableOpacity 
              onPress={clearCache} 
              style={styles.clearCacheButton}
              activeOpacity={0.7}
            >
              <Ionicons name="trash-outline" size={16} color="white" />
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
  webview: {
    flex: 1,
  },
  loadingContainer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#ffffff',
    justifyContent: 'center',
    alignItems: 'center',
  },
  faviconContainer: {
    position: 'relative',
    width: 100,
    height: 100,
    justifyContent: 'center',
    alignItems: 'center',
  },
  favicon: {
    width: 180,
    height: 180,
    zIndex: 10,
  },
  wave: {
    position: 'absolute',
    width: 180,
    height: 180,
    borderRadius:"50%",
    borderWidth: 1,
    borderColor: '#FF8400',
    zIndex: 1,
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
  refreshButtonText: {
    color: '#FF8400',
    fontSize: 16,
    fontWeight: '600',
    marginLeft: 8,
  },
  offlineIndicator: {
    position: 'absolute',
    top: 10,
    right: 10,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    borderRadius: 15,
    paddingVertical: 6,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 1000,
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
  offlineIndicatorDate: {
    color: 'rgba(255, 255, 255, 0.7)',
    fontSize: 10,
    marginLeft: 8,
  },
  refreshButtonSmall: {
    marginLeft: 8,
  },
  clearCacheButton: {
    marginLeft: 8,
  },
});

export default React.memo(App);