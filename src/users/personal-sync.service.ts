import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { Role } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Registro de personal tal como llega desde el sistema de RRHH
 * (GET api.syemape.com/api/publico/personal). El endpoint ya devuelve solo
 * personal ACTIVO. Los nombres de campo se toleran en varias variantes para
 * no acoplarnos a una sola forma: ajusta `mapRecord` si el JSON real difiere.
 */
interface PersonalRecord {
  [key: string]: unknown;
}

export interface SyncResult {
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
}

@Injectable()
export class PersonalSyncService {
  private readonly logger = new Logger(PersonalSyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** URL del endpoint de personal (configurable por entorno). */
  private get sourceUrl(): string {
    return (
      process.env.PERSONAL_API_URL ||
      'http://api.syemape.com/api/publico/personal'
    );
  }

  /**
   * Descarga el personal activo y crea/actualiza usuarios de la app.
   * Idempotente: usa el DNI como `operatorCode` (clave única). No sobrescribe
   * la contraseña de usuarios ya existentes.
   */
  async syncFromPersonal(): Promise<SyncResult> {
    const records = await this.fetchPersonal();
    const result: SyncResult = {
      fetched: records.length,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [],
    };

    for (const raw of records) {
      try {
        const mapped = this.mapRecord(raw);
        if (!mapped) {
          result.skipped++;
          continue;
        }

        const existing = await this.prisma.user.findUnique({
          where: { operatorCode: mapped.operatorCode },
          select: { id: true },
        });

        if (existing) {
          await this.prisma.user.update({
            where: { id: existing.id },
            data: {
              name: mapped.name,
              nickname: mapped.nickname,
              positionTitle: mapped.positionTitle,
              phone: mapped.phone,
              role: mapped.role,
              isActive: true, // reactivar si volvió a estar activo en RRHH
            },
          });
          result.updated++;
        } else {
          // Contraseña inicial = DNI (el usuario debe cambiarla luego).
          const passwordHash = await bcrypt.hash(mapped.operatorCode, 10);
          await this.prisma.user.create({
            data: {
              email: mapped.email,
              operatorCode: mapped.operatorCode,
              name: mapped.name,
              nickname: mapped.nickname,
              positionTitle: mapped.positionTitle,
              phone: mapped.phone,
              role: mapped.role,
              passwordHash,
            },
          });
          result.created++;
        }
      } catch (err) {
        result.errors.push((err as Error).message);
      }
    }

    this.logger.log(
      `Sync personal: ${result.created} creados, ${result.updated} actualizados, ${result.skipped} omitidos, ${result.errors.length} errores.`,
    );
    return result;
  }

  // ── HTTP ─────────────────────────────────────────────────────
  private async fetchPersonal(): Promise<PersonalRecord[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await fetch(this.sourceUrl, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        throw new ServiceUnavailableException(
          `El sistema de personal respondió ${res.status}`,
        );
      }
      const data: unknown = await res.json();
      // Soporta tanto un array plano como { data: [...] } / { personal: [...] }.
      const list = Array.isArray(data)
        ? data
        : ((data as Record<string, unknown>)?.data ??
            (data as Record<string, unknown>)?.personal ??
            []);
      if (!Array.isArray(list)) return [];
      return list as PersonalRecord[];
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      throw new ServiceUnavailableException(
        `No se pudo consultar el sistema de personal: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── Mapeo (ajustar aquí si cambian los nombres de campo) ─────
  private mapRecord(r: PersonalRecord): {
    operatorCode: string;
    name: string;
    nickname?: string;
    email: string;
    positionTitle?: string;
    phone?: string;
    role: Role;
  } | null {
    const dni = this.str(r, ['dni', 'documento', 'numeroDocumento', 'nroDni']);
    if (!dni) return null; // sin DNI no podemos identificarlo

    // Filtro de seguridad (el endpoint ya debería mandar solo activos).
    const estadoActivo = this.str(r, ['estadoActivo', 'estado']);
    const estadoRegistro = this.str(r, ['estadoRegistro']);
    if (estadoActivo && estadoActivo.toUpperCase() !== 'ACTIVO') return null;
    if (estadoRegistro && estadoRegistro.toUpperCase() !== 'ACTIVO') return null;

    const nombres = this.str(r, ['nombres', 'nombre']) ?? '';
    const apellidos = this.str(r, ['apellidos', 'apellido']) ?? '';
    const fullName =
      this.str(r, ['nombreCompleto', 'name']) ??
      `${nombres} ${apellidos}`.trim();

    // El personal no tiene correo: se genera uno sintético solo para cumplir la
    // restricción única. El login real es por DNI (operatorCode) + contraseña.
    const email =
      this.str(r, ['email', 'correo', 'correoElectronico']) ??
      `${dni}@syemape.com`;

    const nickname = this.str(r, ['apelativo', 'nickname', 'indicativo']);
    const cargo = this.str(r, ['cargo', 'positionTitle', 'puesto']);
    const phone = this.str(r, ['telefono', 'celular', 'phone']);
    const rolSugerido = this.str(r, ['rolSugerido', 'tipo']);

    return {
      operatorCode: dni,
      name: fullName || dni,
      nickname,
      email: email.toLowerCase(),
      positionTitle: cargo,
      phone,
      role: this.mapRole(rolSugerido, cargo),
    };
  }

  /**
   * Prioriza `rolSugerido`/`tipo` que envía RRHH; si no viene, infiere del cargo.
   * ADMIN nunca se asigna automáticamente (se gestiona manualmente).
   */
  private mapRole(rolSugerido?: string, cargo?: string): Role {
    const r = (rolSugerido ?? '').toUpperCase();
    if (r.includes('SUPERVISOR') || r === 'SUP') return Role.SUPERVISOR;
    if (r.includes('OPERADOR') || r.includes('OPERATOR') || r === 'OPE')
      return Role.OPERATOR;
    const c = (cargo ?? '').toUpperCase();
    if (c.includes('SUPERVISOR') || c.includes('JEFE')) return Role.SUPERVISOR;
    return Role.OPERATOR;
  }

  /** Lee la primera clave presente y devuelve su valor como string limpio. */
  private str(obj: PersonalRecord, keys: string[]): string | undefined {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number') return String(v);
    }
    return undefined;
  }
}
