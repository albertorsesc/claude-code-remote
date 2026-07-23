// The RNG polyfill MUST load before any @noble crypto call (it reads globalThis.crypto
// .getRandomValues). This is why the app overrides the default `expo-router/entry` main.
import 'react-native-get-random-values';
import 'expo-router/entry';
