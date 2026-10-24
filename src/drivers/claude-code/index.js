// The Claude Code driver: the per-harness part of `hs` (design note v0.2 §7.3).

import descriptor from './descriptor.js';
import { stateInEffect } from './state.js';
import * as delivery from './deliver.js';
import * as common from '../../driver-common.js';

export { descriptor };

export const describeHarness = () => common.describeHarness(descriptor);
export const detect = (args) => common.detect(descriptor, args);
export const observe = (args, opts) => common.observe(descriptor, stateInEffect, args, opts, driver);
export const deliverables = (resolved, ctx) => delivery.deliverables(resolved, { ...ctx, descriptor });
export const liveCheck = delivery.liveCheck;
export const unmanaged = (folder, managed, home) => delivery.unmanaged(folder, managed, descriptor, home);
export const launchParts = (resolved, ctx) => delivery.launchParts(resolved, { ...ctx, descriptor });

const driver = { descriptor, detect, deliverables, liveCheck, unmanaged, launchParts };
export default driver;
