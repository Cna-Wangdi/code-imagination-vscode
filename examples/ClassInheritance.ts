export class BaseService {
  protected normalize(value: string): string {
    return value.trim();
  }
}

export class UserService extends BaseService {
  save(value: string): string {
    return this.normalize(value);
  }
}
