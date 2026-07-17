import {
  AppErrorCode,
  appError,
  type AddKekInput,
  type AppError,
  type EmitRecoveryKeyfileInput,
  type RemoveKekInput,
  type RewrapKekInput,
  type SessionSecurityAdmin,
} from '../../application/index.js';
import { err, ok, type Result } from '../../shared/index.js';
import type { OperatorClientPort } from './client.js';

const map = <T>(result: Result<T, string>): Result<T, AppError> =>
  result.ok
    ? result
    : err(appError(AppErrorCode.GatewayUnavailable, result.error));

/** Setup-facing security port backed only by authenticated daemon operations. */
export class OperatorSessionSecurityAdmin implements SessionSecurityAdmin {
  public constructor(private readonly client: OperatorClientPort) {}

  public async addKek(input: AddKekInput): Promise<Result<void, AppError>> {
    // No re-authenticate after the transition: the server carries the
    // transition socket into the new authentication generation.
    const changed = map(await this.client.setPin(input.current, input.pin));
    return changed.ok ? ok(undefined) : changed;
  }

  public async rewrapKek(input: RewrapKekInput): Promise<Result<void, AppError>> {
    const changed = map(
      await this.client.changePin(input.current, input.replacement),
    );
    return changed.ok ? ok(undefined) : changed;
  }

  public async removeKek(input: RemoveKekInput): Promise<Result<void, AppError>> {
    const changed = map(await this.client.removePin(input.current));
    return changed.ok ? ok(undefined) : changed;
  }

  public async emitRecoveryKeyfile(
    input: EmitRecoveryKeyfileInput,
  ): Promise<Result<void, AppError>> {
    const exported = map(
      await this.client.exportRecovery(input.current, input.outputPath),
    );
    return exported.ok ? ok(undefined) : exported;
  }
}
