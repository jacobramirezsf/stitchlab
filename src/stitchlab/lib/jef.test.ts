import { describe, expect, it } from "vitest";
import { writeJef } from "./jef";
import { CMD, type Stitch } from "./pattern";
const date = new Date("2026-09-13T12:00:00Z");
function records(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer);
  let i = view.getUint32(0, true), x = 0, y = 0;
  const result: Stitch[] = [];
  const signed = (b: number) => b > 127 ? b - 256 : b;
  while (i < bytes.length) {
    const first = bytes[i++], second = bytes[i++];
    if (first === 0x80 && second === 0x10) { result.push({ x, y, cmd: CMD.END }); break; }
    const special = first === 0x80;
    const dx = signed(special ? bytes[i++] : first), dy = -signed(special ? bytes[i++] : second);
    expect(Math.abs(dx)).toBeLessThanOrEqual(127); expect(Math.abs(dy)).toBeLessThanOrEqual(127);
    x += dx; y += dy;
    result.push({ x, y, cmd: special ? second === 2 ? CMD.JUMP : CMD.COLOR_CHANGE : CMD.STITCH });
  }
  return result;
}
describe("JEF export", () => {
  it("writes the documented header and signed y-up command bytes", () => {
    const bytes = writeJef([{x: -10,y:20,cmd:CMD.JUMP},{x:30,y:-40,cmd:CMD.STITCH},{x:30,y:-40,cmd:CMD.END}], ["#ff0000"], date);
    const v = new DataView(bytes.buffer);
    expect(v.getUint32(0,true)).toBe(124); expect(v.getUint32(24,true)).toBe(1);
    expect(v.getUint32(28,true)).toBe(4); expect(v.getUint32(116,true)).toBe(10);
    expect(new TextDecoder().decode(bytes.slice(8,22))).toBe("20260913120000");
    expect([...bytes.slice(124)]).toEqual([128,2,246,236,40,60,128,16]);
  });
  it("preserves both signs at the 127 boundary without emitting a false escape", () => {
    const stitches: Stitch[] = [{x:127,y:-127,cmd:CMD.STITCH},{x:0,y:0,cmd:CMD.STITCH},{x:-128,y:128,cmd:CMD.JUMP}];
    const r = records(writeJef(stitches, []));
    expect(r[0]).toEqual(stitches[0]); expect(r[1]).toEqual(stitches[1]); expect(r.at(-2)).toEqual(stitches[2]);
  });
  it("splits long stitches as stitches and long jumps as jumps", () => {
    const r = records(writeJef([{x:600,y:300,cmd:CMD.STITCH},{x:-600,y:-300,cmd:CMD.JUMP}], []));
    expect(r.slice(0,5).every((s) => s.cmd === CMD.STITCH)).toBe(true);
    expect(r.slice(5,-1).every((s) => s.cmd === CMD.JUMP)).toBe(true);
    expect(r.at(-1)).toEqual({x:-600,y:-300,cmd:CMD.END});
  });
  it("keeps color sequence, stop placeholders, and distinct adjacent cones", () => {
    const bytes = writeJef([{x:0,y:0,cmd:CMD.STITCH},{x:0,y:0,cmd:CMD.COLOR_CHANGE},{x:1,y:1,cmd:CMD.STITCH},{x:1,y:1,cmd:CMD.STOP},{x:2,y:2,cmd:CMD.STITCH}], ["#ff0000","#fe0000"]);
    const v = new DataView(bytes.buffer);
    expect(v.getUint32(24,true)).toBe(3); expect(v.getUint32(116,true)).not.toBe(v.getUint32(120,true)); expect(v.getUint32(124,true)).toBe(0);
    expect(v.getUint32(28,true)).toBe((bytes.length-v.getUint32(0,true))/2);
  });
  it("uses non-negative fitted hoop margins and -1 for smaller hoops", () => {
    const bytes = writeJef([{x:-650,y:-950,cmd:CMD.JUMP},{x:650,y:950,cmd:CMD.STITCH}], []);
    const v = new DataView(bytes.buffer);
    expect(v.getUint32(32,true)).toBe(2); expect(v.getInt32(52,true)).toBe(-1); expect(v.getInt32(84,true)).toBe(50);
  });
  it("handles empty input, trims, missing colors and termination", () => {
    expect(records(writeJef([], []))).toEqual([{x:0,y:0,cmd:CMD.END}]);
    const r=records(writeJef([{x:0,y:0,cmd:CMD.TRIM},{x:0,y:0,cmd:CMD.END},{x:10,y:10,cmd:CMD.STITCH}], []));
    expect(r.filter((s)=>s.cmd===CMD.JUMP)).toHaveLength(3); expect(r).toHaveLength(4);
    expect(()=>writeJef([{x:NaN,y:0,cmd:CMD.STITCH}], [])).toThrow(/finite/);
  });
});
