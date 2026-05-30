declare module "yencode" {
  export function decode(data: Buffer, stripDots?: boolean): Buffer;
  export function decodeTo(data: Buffer, output: Buffer, stripDots?: boolean): number;

  const yencode: {
    decode: typeof decode;
    decodeTo: typeof decodeTo;
  };

  export default yencode;
}
