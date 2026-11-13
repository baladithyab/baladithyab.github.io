// Compile-time replacement for '@/lib/meeting-point' in the scalar UI benchmark
// build only. The original module is imported relatively because the alias for
// '@/lib/meeting-point' resolves to this file.
export * from '../../src/lib/meeting-point'
export { prepareScalarSearch as prepareMeetingSearch } from './scalar-search'
