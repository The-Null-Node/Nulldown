import "jest-mock";

declare module "jest-mock" {
  interface MockInstance<T extends FunctionLike = UnknownFunction> {
    mockRejectedValue(
      value: T extends UnknownFunction ? unknown : RejectType<T>,
    ): this;
    mockRejectedValueOnce(
      value: T extends UnknownFunction ? unknown : RejectType<T>,
    ): this;
    mockResolvedValue(
      value: T extends UnknownFunction ? unknown : ResolveType<T>,
    ): this;
    mockResolvedValueOnce(
      value: T extends UnknownFunction ? unknown : ResolveType<T>,
    ): this;
    mockReturnValue(
      value: T extends UnknownFunction ? unknown : ReturnType<T>,
    ): this;
    mockReturnValueOnce(
      value: T extends UnknownFunction ? unknown : ReturnType<T>,
    ): this;
  }
}
