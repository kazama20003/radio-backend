import { SetMetadata } from '@nestjs/common';
import { Role } from '../../generated/prisma/client';

export const ROLES_KEY = 'roles';

/** Restringe una ruta a los roles indicados (usar junto a RolesGuard). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
